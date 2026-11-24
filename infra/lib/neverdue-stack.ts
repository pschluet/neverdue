import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';

export interface NeverdueConfig {
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
  certificateArn: string;
  githubRepo: string; // owner/repo
  scrapeCron: string;
  scheduleTimeZone: string;
  vapidPublicKey: string;
  oidcProviderArn: string;
  sesFromEmail: string;
  sesDomain: string;
  /** Emails allowed to use the in-app admin screen. */
  adminEmails: string[];
}

const backend = (file: string) =>
  fileURLToPath(new URL(`../../backend/src/${file}`, import.meta.url));
const lockFile = fileURLToPath(new URL('../../package-lock.json', import.meta.url));

export class NeverdueStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { config: NeverdueConfig }) {
    super(scope, id, props);
    const c = props.config;
    const userPaths = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: 'neverdue/users/*',
    });
    const vapidParam = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: 'neverdue/vapid-private-key',
    });

    // ---- Data ----
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    // ---- Auth ----
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true } },
      accountRecovery: cognito.AccountRecovery.NONE,
      email: cognito.UserPoolEmail.withSES({
        fromEmail: c.sesFromEmail,
        fromName: 'Neverdue',
        sesRegion: 'us-east-1',
        sesVerifiedDomain: c.sesDomain,
      }),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { user: true },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // ---- Lambdas ----
    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      depsLockFilePath: lockFile,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    };
    const scraper = new NodejsFunction(this, 'Scraper', {
      ...common,
      entry: backend('scrape.ts'),
      timeout: cdk.Duration.minutes(5),
      environment: { TABLE_NAME: table.tableName },
    });
    const api = new NodejsFunction(this, 'Api', {
      ...common,
      entry: backend('api.ts'),
      timeout: cdk.Duration.seconds(29),
      environment: {
        TABLE_NAME: table.tableName,
        SCRAPER_FUNCTION_NAME: scraper.functionName,
        USER_POOL_ID: userPool.userPoolId,
        ADMIN_EMAILS: c.adminEmails.join(','),
      },
    });
    const notifier = new NodejsFunction(this, 'Notifier', {
      ...common,
      entry: backend('notify.ts'),
      timeout: cdk.Duration.minutes(1),
      environment: { TABLE_NAME: table.tableName, VAPID_PUBLIC_KEY: c.vapidPublicKey },
    });

    table.grantReadWriteData(api);
    table.grantReadWriteData(scraper);
    table.grantReadWriteData(notifier);
    scraper.grantInvoke(api);
    // The API signs in on the user's behalf (validate + renew), so it can read credentials too.
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ssm:GetParameter',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
          'ssm:AddTagsToResource',
        ],
        resources: [userPaths],
      }),
    );
    // Admin screen: remove a user's stored library credentials, and manage Cognito users.
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath', 'ssm:DeleteParameters'],
        resources: [
          userPaths,
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: 'neverdue/users',
          }),
        ],
      }),
    );
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    scraper.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [userPaths] }),
    );
    notifier.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [vapidParam] }),
    );

    // ---- HTTP API ----
    const httpApi = new apigw.HttpApi(this, 'HttpApi', { createDefaultStage: true });
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('ApiIntegration', api),
      authorizer: new HttpJwtAuthorizer(
        'JwtAuthorizer',
        `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
        { jwtAudience: [userPoolClient.userPoolClientId] },
      ),
    });

    // ---- Schedules ----
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    scraper.grantInvoke(schedulerRole);
    notifier.grantInvoke(schedulerRole);
    const schedule = (name: string, expression: string, fn: lambda.IFunction) =>
      new scheduler.CfnSchedule(this, name, {
        scheduleExpression: expression,
        scheduleExpressionTimezone: c.scheduleTimeZone,
        flexibleTimeWindow: { mode: 'OFF' },
        target: { arn: fn.functionArn, roleArn: schedulerRole.roleArn, input: '{}' },
      });
    schedule('DailyScrape', c.scrapeCron, scraper);
    schedule('HourlyNotify', 'cron(0 * * * ? *)', notifier);

    // ---- Site ----
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const certificate = acm.Certificate.fromCertificateArn(this, 'Cert', c.certificateArn);
    const apiOrigin = new origins.HttpOrigin(
      cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint)),
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      },
    );
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [c.domainName],
      certificate,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: c.hostedZoneId,
      zoneName: c.hostedZoneName,
    });
    const recordName = c.domainName.replace(`.${c.hostedZoneName}`, '');
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, 'AliasA', { zone, recordName, target });
    new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName, target });

    // ---- GitHub deploy role ----
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidc',
      c.oidcProviderArn,
    );
    const deployRole = new iam.Role(this, 'DeployRole', {
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${c.githubRepo}:*`,
            `repo:${c.githubRepo.replace('/', '@*/')}@*:*`,
          ],
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/CDKToolkit/*`,
        ],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          this.formatArn({
            service: 'cloudformation',
            resource: 'stack',
            resourceName: `${this.stackName}/*`,
          }),
        ],
      }),
    );
    siteBucket.grantReadWrite(deployRole);
    siteBucket.grantDelete(deployRole);
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          this.formatArn({
            service: 'cloudfront',
            region: '',
            resource: 'distribution',
            resourceName: distribution.distributionId,
          }),
        ],
      }),
    );

    // ---- Outputs ----
    const out = (name: string, value: string) => new cdk.CfnOutput(this, name, { value });
    out('SiteUrl', `https://${c.domainName}`);
    out('UserPoolId', userPool.userPoolId);
    out('UserPoolClientId', userPoolClient.userPoolClientId);
    out('SiteBucketName', siteBucket.bucketName);
    out('DistributionId', distribution.distributionId);
    out('DeployRoleArn', deployRole.roleArn);
    out('TableName', table.tableName);
  }
}
