#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {
  CloudfrontCdnTemplateStack,
  Config,
} from '../lib/cdk-stack';

const app = new cdk.App();

const suffix = app.node.tryGetContext('suffix');

const env = app.node.tryGetContext('env');
const config: Config & { stackName: string } = env
  ? app.node.tryGetContext(env)
  : app.node.tryGetContext('default');

const stackName = `${config.stackName}${suffix ? `-${suffix}` : ''}`;

new CloudfrontCdnTemplateStack(app, stackName, {
  cloudfront: config.cloudfront,
  environment: env,
  env: {
    account: app.account,
    region: app.region,
  },
  suffix,
});
