// Usage: npx tsx scripts/put-vapid-key.ts
// Generates a VAPID key pair, stores the private key in SSM (/neverdue/vapid-private-key) and prints
// the public key to put in infra/cdk.json (neverdue.vapidPublicKey). Refuses to overwrite an existing key.
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import webpush from 'web-push';

const ssm = new SSMClient({ region: 'us-east-1' });
const Name = '/neverdue/vapid-private-key';
try {
  await ssm.send(new GetParameterCommand({ Name }));
  console.error(
    `${Name} already exists. Delete it first if you really want to rotate keys (this invalidates every subscription).`,
  );
  process.exit(1);
} catch (e) {
  if ((e as Error).name !== 'ParameterNotFound') throw e;
}
const keys = webpush.generateVAPIDKeys();
await ssm.send(new PutParameterCommand({ Name, Value: keys.privateKey, Type: 'SecureString' }));
console.log(
  'Private key stored in SSM.\nPublic key (put in infra/cdk.json as vapidPublicKey):\n' +
    keys.publicKey,
);
