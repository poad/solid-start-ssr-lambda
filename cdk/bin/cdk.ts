#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';

const app = new cdk.App();
const suffix = app.node.tryGetContext('suffix') ;
const name = `solid-start-ssr-lambda${suffix ? `-${suffix}` : ''}`;
new CdkStack(app, `${name}-stack`, {
  name,
});
