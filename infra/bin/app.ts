import { App } from 'aws-cdk-lib';
import { NeverdueStack, type NeverdueConfig } from '../lib/neverdue-stack.js';

const app = new App();
const config = app.node.tryGetContext('neverdue') as NeverdueConfig;
new NeverdueStack(app, 'NeverdueStack', {
  config,
  env: { region: 'us-east-1', account: process.env.CDK_DEFAULT_ACCOUNT },
});
