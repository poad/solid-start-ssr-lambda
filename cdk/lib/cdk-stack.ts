import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import { buildFrontend } from './process/setup';

interface CdkStackProps extends cdk.StackProps {
  name: string
}

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CdkStackProps) {
    super(scope, id, props);

    const { name } = props;

    buildFrontend();

    const functionName = `${name}-function`;
    new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_DAY,
    });

    const solidStartsDistPath = path.join(__dirname, '../../.output/server');

    const handler = new lambda.Function(this, 'Handler', {
      functionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(solidStartsDistPath),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
    });
    const url = handler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    new cdk.CfnOutput(this, 'Output', {
      value: url.url,
    });

  }
}
