// Usage: npx tsx scripts/create-user.ts <user-pool-id> <email>
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

const [poolId, email] = process.argv.slice(2);
if (!poolId || !email) {
  console.error('Usage: create-user.ts <user-pool-id> <email>');
  process.exit(1);
}
const r = await new CognitoIdentityProviderClient({ region: 'us-east-1' }).send(
  new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: email,
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ],
  }),
);
console.log(
  `Created ${email} (sub ${r.User?.Attributes?.find((a) => a.Name === 'sub')?.Value}). They can now sign in with an emailed code.`,
);
