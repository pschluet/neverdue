// Usage: npx tsx scripts/delete-user.ts <user-pool-id> <table-name> <email>
// Deletes the Cognito user, every DynamoDB item under USER#<sub>, and their SSM parameters.
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  DeleteParametersCommand,
  GetParametersByPathCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

const [poolId, table, email] = process.argv.slice(2);
if (!poolId || !table || !email) {
  console.error('Usage: delete-user.ts <user-pool-id> <table-name> <email>');
  process.exit(1);
}
const region = 'us-east-1';
const cognito = new CognitoIdentityProviderClient({ region });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const ssm = new SSMClient({ region });

const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
const sub = user.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
if (!sub) throw new Error('User has no sub');

let removed = 0;
let key: Record<string, unknown> | undefined;
do {
  const page = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${sub}` },
      ExclusiveStartKey: key,
    }),
  );
  for (const item of page.Items ?? []) {
    await doc.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } }));
    removed++;
  }
  key = page.LastEvaluatedKey;
} while (key);

let token: string | undefined;
let params = 0;
do {
  const page = await ssm.send(
    new GetParametersByPathCommand({
      Path: `/neverdue/users/${sub}`,
      Recursive: true,
      NextToken: token,
    }),
  );
  const names = (page.Parameters ?? []).map((p) => p.Name!).filter(Boolean);
  for (let i = 0; i < names.length; i += 10)
    await ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
  params += names.length;
  token = page.NextToken;
} while (token);

await cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: email }));
console.log(`Deleted ${email}: ${removed} table items, ${params} SSM parameters.`);
