import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { NeverdueStack } from '../lib/neverdue-stack.js';

let template: Template;

beforeAll(() => {
  // Skip esbuild bundling: these tests only check the template.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new NeverdueStack(app, 'Test', {
    env: { account: '123456789012', region: 'us-east-1' },
    config: {
      domainName: 'neverdue.example.com',
      hostedZoneId: 'Z123',
      hostedZoneName: 'example.com',
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      githubRepo: 'owner/repo',
      scrapeCron: 'cron(0 6 * * ? *)',
      scheduleTimeZone: 'America/Chicago',
      vapidPublicKey: 'pub',
      oidcProviderArn:
        'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
      sesFromEmail: 'no-reply@example.com',
      sesDomain: 'example.com',
      adminEmails: ['admin@example.com'],
    },
  });
  template = Template.fromStack(stack);
});

/** All statements on policies attached to the role of the function with this logical-id prefix. */
function statementsFor(prefix: string) {
  const fns = template.findResources('AWS::Lambda::Function');
  const fnId = Object.keys(fns).find((k) => k.startsWith(prefix))!;
  const roleRef = (fns[fnId]!.Properties.Role['Fn::GetAtt'] as string[])[0]!;
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(roleRef))
    .flatMap(
      (p) =>
        p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[],
    );
}
const actionsOf = (st: { Action: string | string[] }[]) => st.flatMap((s) => [s.Action].flat());

describe('NeverdueStack', () => {
  it('protects the API with a Cognito JWT authorizer', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /api/{proxy+}',
      AuthorizationType: 'JWT',
    });
  });

  it('is invite-only with email OTP', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      Policies: Match.objectLike({
        SignInPolicy: { AllowedFirstAuthFactors: Match.arrayWith(['EMAIL_OTP']) },
      }),
    });
  });

  it('gives the API credential write/read, the scraper read-only, and the notifier no user-path access', () => {
    const api = actionsOf(statementsFor('Api'));
    expect(api).toEqual(
      expect.arrayContaining(['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameter']),
    );
    const scraper = actionsOf(statementsFor('Scraper'));
    expect(scraper).toContain('ssm:GetParameter');
    expect(scraper).not.toContain('ssm:PutParameter');
    expect(scraper).not.toContain('ssm:DeleteParameter');
    const notifier = statementsFor('Notifier').filter((s) =>
      [s.Action].flat().some((a) => a.startsWith('ssm:')),
    );
    expect(JSON.stringify(notifier)).toContain('vapid-private-key');
    expect(JSON.stringify(notifier)).not.toContain('neverdue/users');
  });

  it('scopes credential access to /neverdue/users/*', () => {
    for (const fn of ['Api', 'Scraper']) {
      const ssm = statementsFor(fn).filter((s) =>
        [s.Action].flat().some((a) => a.startsWith('ssm:')),
      );
      expect(JSON.stringify(ssm)).toContain('parameter/neverdue/users/*');
    }
  });

  it('lets only the API manage users, scoped to this pool, and tells it who the admins are', () => {
    const cognito = (fn: string) =>
      statementsFor(fn).filter((s) => [s.Action].flat().some((a) => a.startsWith('cognito-idp:')));
    expect(actionsOf(cognito('Api'))).toEqual(
      expect.arrayContaining(['cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser']),
    );
    expect(JSON.stringify(cognito('Api'))).toContain('UserPool');
    expect(JSON.stringify(cognito('Api'))).not.toContain('"*"');
    expect(cognito('Scraper')).toHaveLength(0);
    expect(cognito('Notifier')).toHaveLength(0);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ ADMIN_EMAILS: 'admin@example.com' }) },
    });
  });

  it('runs the schedules in America/Chicago', () => {
    const schedules = Object.values(template.findResources('AWS::Scheduler::Schedule'));
    expect(schedules).toHaveLength(2);
    for (const s of schedules)
      expect(s.Properties.ScheduleExpressionTimezone).toBe('America/Chicago');
  });

  it('uses Node 22 on ARM64 for every function', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (f) => f.Properties.Environment?.Variables?.TABLE_NAME,
    );
    expect(fns).toHaveLength(3);
    for (const f of fns) {
      expect(f.Properties.Runtime).toBe('nodejs22.x');
      expect(f.Properties.Architectures).toEqual(['arm64']);
    }
  });

  it('has no VPC, NAT or always-on compute', () => {
    for (const type of [
      'AWS::EC2::VPC',
      'AWS::EC2::NatGateway',
      'AWS::RDS::DBInstance',
      'AWS::ECS::Service',
    ]) {
      expect(Object.keys(template.findResources(type))).toHaveLength(0);
    }
  });

  it('retains the table, keeps it on-demand and has no SPA error rewrites', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: { BillingMode: 'PAY_PER_REQUEST' },
    });
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]!;
    expect(dist.Properties.DistributionConfig.CustomErrorResponses).toBeUndefined();
  });

  it('routes /api/* to the API with caching disabled', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/api/*',
            AllowedMethods: Match.arrayWith(['PATCH', 'DELETE']),
          }),
        ],
      }),
    });
  });

  it('limits the deploy role to this repo', () => {
    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    const text = JSON.stringify(roles);
    expect(text).toContain('repo:owner/repo:*');
    expect(text).toContain('repo:owner@*/repo@*:*');
    expect(text).not.toContain('AdministratorAccess');
  });
});
