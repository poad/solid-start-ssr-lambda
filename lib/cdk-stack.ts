import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as awslogs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { buildFrontend } from './process/setup';
import { NitroAsset } from 'nitro-aws-cdk-lib';

export interface Config extends cdk.StackProps {
  cloudfront: {
    comment: string;
  };
}

interface CloudfrontCdnTemplateStackProps extends Config {
  environment?: string;
  suffix?: string;
}

export class CloudfrontCdnTemplateStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: CloudfrontCdnTemplateStackProps,
  ) {
    super(scope, id, props);

    const {
      environment,
      cloudfront: { comment },
      suffix,
    } = props;

    buildFrontend();

    const functionName = `${environment ? `${environment}-` : ''}solid-start-ssr-lambda${suffix ? `-${suffix}` : ''}`;
    new awslogs.LogGroup(this, 'ApolloLambdaFunctionLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: awslogs.RetentionDays.ONE_DAY,
    });

    const devOptions = {
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
      },
      applicationLogLevelV2: lambda.ApplicationLogLevel.TRACE,
    };

    const nitro = new NitroAsset(this, "NitroAsset", {
      path: "../",
    });

    const fn = new lambda.Function(this, 'Lambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: nitro.serverHandler,
      handler: 'index.handler',
      functionName,
      retryAttempts: 0,
      environment: {
        ...devOptions.environment,
      },
      memorySize: 256,
      timeout: cdk.Duration.minutes(1),
      role: new iam.Role(this, 'ApolloLambdaFunctionExecutionRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLambdaExecute'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('CloudFrontReadOnlyAccess'),
        ],
        inlinePolicies: {
          'bedrock-policy': new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  'bedrock:InvokeModel*',
                  'logs:PutLogEvents',
                ],
                resources: ['*'],
              }),
            ],
          }),
        },
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: devOptions.applicationLogLevelV2,
    });

    const cf = new cloudfront.Distribution(this, 'CloudFront', {
      comment,
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(fn.addFunctionUrl({
          authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
          invokeMode: cdk.aws_lambda.InvokeMode.RESPONSE_STREAM,
        }),
        {
          originId: 'lambda',
          readTimeout: cdk.Duration.minutes(1),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: new cdk.aws_cloudfront.ResponseHeadersPolicy(
          this,
          'ResponseHeadersPolicy',
          {
            corsBehavior: {
              accessControlAllowOrigins: [
                'http://localhost:4173',
                'http://localhost:5173',
              ],
              accessControlAllowHeaders: ['*'],
              accessControlAllowMethods: ['ALL'],
              accessControlAllowCredentials: false,
              originOverride: true,
            },
          },
        ),
      },
      httpVersion: cloudfront.HttpVersion.HTTP3,
    });

    new cdk.CfnOutput(this, 'AccessURLOutput', {
      value: `https://${cf.distributionDomainName}`,
    });
  }
}
