import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as awslogs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { buildFrontend } from './process/setup';
import * as deployment from 'aws-cdk-lib/aws-s3-deployment';
export class CloudfrontCdnTemplateStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const { bucketName, appName, environment, cloudfront: { comment }, endpoint, apiKey, deployName, apiVersion, langfuse, anthoropicApiKey, claudeModel, langsmith, } = props;
        buildFrontend();
        const functionName = `${environment ? `${environment}-` : ''}llm-ts-example-api`;
        new awslogs.LogGroup(this, 'ApolloLambdaFunctionLogGroup', {
            logGroupName: `/aws/lambda/${functionName}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: awslogs.RetentionDays.ONE_DAY,
        });
        const devOptions = {
            // environment: {
            //   NODE_OPTIONS: '--enable-source-maps',
            // },
            // bundling: {
            //   sourceMap: true,
            //   sourceMapMode: nodejs.SourceMapMode.BOTH,
            //   sourcesContent: true,
            //   keepNames: true,
            // },
            applicationLogLevelV2: lambda.ApplicationLogLevel.TRACE,
        };
        const apiRootPath = '/api/';
        const langfuseEnv = langfuse ? {
            LANGFUSE_SECRET_KEY: langfuse.sk,
            LANGFUSE_PUBLIC_KEY: langfuse.pk,
            ...(langfuse.endpoint ? {
                LANGFUSE_BASEURL: langfuse.endpoint,
            } : {}),
        } : {};
        const langsmithEnv = langsmith ? {
            LANGCHAIN_TRACING_V2: 'true',
            LANGCHAIN_ENDPOINT: langsmith.endpoint,
            LANGCHAIN_API_KEY: langsmith.apiKey,
            LANGCHAIN_PROJECT: langsmith.project,
        } : {};
        const fn = new nodejs.NodejsFunction(this, 'Lambda', {
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            entry: './lambda/index.ts',
            functionName,
            retryAttempts: 0,
            environment: {
                // ...devOptions.environment,
                API_ROOT_PATH: apiRootPath,
                AZURE_OPENAI_API_INSTANCE_NAME: endpoint,
                AZURE_OPENAI_API_DEPLOYMENT_NAME: deployName,
                AZURE_OPENAI_API_KEY: apiKey,
                AZURE_OPENAI_API_VERSION: apiVersion,
                ANTHROPIC_API_KEY: anthoropicApiKey,
                CLAUDE_MODEL: claudeModel,
                ...langfuseEnv,
                ...langsmithEnv,
            },
            bundling: {
                minify: true,
                // ...devOptions.bundling,
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
        const s3bucket = new s3.Bucket(this, 'S3Bucket', {
            bucketName,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
        });
        const websiteIndexPageForwardFunction = new cloudfront.Function(this, 'WebsiteIndexPageForwardFunction', {
            functionName: 'llm-ts-example-api-index-forword',
            code: cloudfront.FunctionCode.fromFile({
                filePath: 'function/index.js',
            }),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
        });
        const functionAssociations = [
            {
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                function: websiteIndexPageForwardFunction,
            },
        ];
        const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'S3OAC', {
            originAccessControlName: 'OAC for S3 (llm-ts-example-api)',
            signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
        });
        const cf = new cloudfront.Distribution(this, 'CloudFront', {
            comment,
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(s3bucket, {
                    originAccessControl,
                    originAccessLevels: [cloudfront.AccessLevel.READ],
                    originId: 's3',
                }),
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                functionAssociations,
            },
            additionalBehaviors: {
                [`${apiRootPath}*`]: {
                    origin: new origins.FunctionUrlOrigin(fn.addFunctionUrl({
                        authType: cdk.aws_lambda.FunctionUrlAuthType.AWS_IAM,
                        invokeMode: cdk.aws_lambda.InvokeMode.RESPONSE_STREAM,
                    }), {
                        originId: 'lambda',
                        readTimeout: cdk.Duration.minutes(1),
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                    responseHeadersPolicy: new cdk.aws_cloudfront.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
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
                    }),
                },
            },
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        });
        const deployRole = new iam.Role(this, 'DeployWebsiteRole', {
            roleName: `${appName}-deploy-role`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            inlinePolicies: {
                's3-policy': new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: ['s3:*'],
                            resources: [`${s3bucket.bucketArn}/`, `${s3bucket.bucketArn}/*`],
                        }),
                    ],
                }),
            },
        });
        new deployment.BucketDeployment(this, 'DeployWebsite', {
            sources: [deployment.Source.asset(`${process.cwd()}/../app/dist`)],
            destinationBucket: s3bucket,
            destinationKeyPrefix: '/',
            exclude: ['.DS_Store', '*/.DS_Store'],
            prune: true,
            retainOnDelete: false,
            role: deployRole,
        });
        // OAC for Lambda
        const cfnOriginAccessControl = new cdk.aws_cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
            originAccessControlConfig: {
                name: `OAC for Lambda Functions URL (${functionName})`,
                originAccessControlOriginType: 'lambda',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',
            },
        });
        const cfnDistribution = cf.node.defaultChild;
        // Set OAC for Lambda
        cfnDistribution.addPropertyOverride('DistributionConfig.Origins.1.OriginAccessControlId', cfnOriginAccessControl.attrId);
        // Add permission Lambda Function URLs
        fn.addPermission('AllowCloudFrontServicePrincipal', {
            principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
            action: 'lambda:InvokeFunctionUrl',
            sourceArn: `arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${cf.distributionId}`,
        });
        new cdk.CfnOutput(this, 'AccessURLOutput', {
            value: `https://${cf.distributionDomainName}`,
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2RrLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBSyxHQUFHLE1BQU0sYUFBYSxDQUFDO0FBRW5DLE9BQU8sS0FBSyxFQUFFLE1BQU0sb0JBQW9CLENBQUM7QUFDekMsT0FBTyxLQUFLLFVBQVUsTUFBTSw0QkFBNEIsQ0FBQztBQUN6RCxPQUFPLEtBQUssT0FBTyxNQUFNLG9DQUFvQyxDQUFDO0FBQzlELE9BQU8sS0FBSyxNQUFNLE1BQU0sd0JBQXdCLENBQUM7QUFDakQsT0FBTyxLQUFLLE1BQU0sTUFBTSwrQkFBK0IsQ0FBQztBQUN4RCxPQUFPLEtBQUssT0FBTyxNQUFNLHNCQUFzQixDQUFDO0FBQ2hELE9BQU8sS0FBSyxHQUFHLE1BQU0scUJBQXFCLENBQUM7QUFDM0MsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ2hELE9BQU8sS0FBSyxVQUFVLE1BQU0sK0JBQStCLENBQUM7QUE4QjVELE1BQU0sT0FBTywwQkFBMkIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUN2RCxZQUNFLEtBQWdCLEVBQ2hCLEVBQVUsRUFDVixLQUFzQztRQUV0QyxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLEVBQ0osVUFBVSxFQUNWLE9BQU8sRUFDUCxXQUFXLEVBQ1gsVUFBVSxFQUFFLEVBQUUsT0FBTyxFQUFFLEVBQ3ZCLFFBQVEsRUFDUixNQUFNLEVBQ04sVUFBVSxFQUNWLFVBQVUsRUFDVixRQUFRLEVBQ1IsZ0JBQWdCLEVBQ2hCLFdBQVcsRUFDWCxTQUFTLEdBQ1YsR0FBRyxLQUFLLENBQUM7UUFFVixhQUFhLEVBQUUsQ0FBQztRQUVoQixNQUFNLFlBQVksR0FBRyxHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsR0FBRyxXQUFXLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxvQkFBb0Is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RUFBRSxXQUFXLEVBQUUsQ0FBQyxzQkFBc0IsRUFBRTtTQUM5QyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udCc7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgbm9kZWpzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCAqIGFzIGF3c2xvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgYnVpbGRGcm9udGVuZCB9IGZyb20gJy4vcHJvY2Vzcy9zZXR1cCc7XG5pbXBvcnQgKiBhcyBkZXBsb3ltZW50IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50JztcblxuZXhwb3J0IGludGVyZmFjZSBDb25maWcgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIGJ1Y2tldE5hbWU6IHN0cmluZztcbiAgYXBwTmFtZTogc3RyaW5nO1xuICBjbG91ZGZyb250OiB7XG4gICAgY29tbWVudDogc3RyaW5nO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgQ2xvdWRmcm9udENkblRlbXBsYXRlU3RhY2tQcm9wcyBleHRlbmRzIENvbmZpZyB7XG4gIGVudmlyb25tZW50Pzogc3RyaW5nO1xuICBlbmRwb2ludDogc3RyaW5nO1xuICBhcGlLZXk6IHN0cmluZztcbiAgZGVwbG95TmFtZTogc3RyaW5nO1xuICBhcGlWZXJzaW9uOiBzdHJpbmc7XG4gIGxhbmdmdXNlPzoge1xuICAgIHNrOiBzdHJpbmc7XG4gICAgcGs6IHN0cmluZztcbiAgICBlbmRwb2ludDogc3RyaW5nO1xuICB9O1xuICBhbnRob3JvcGljQXBpS2V5OiBzdHJpbmc7XG4gIGNsYXVkZU1vZGVsOiBzdHJpbmc7XG4gIGxhbmdzbWl0aD86IHtcbiAgICBhcGlLZXk6IHN0cmluZztcbiAgICBwcm9qZWN0OiBzdHJpbmc7XG4gICAgZW5kcG9pbnQ6IHN0cmluZztcbiAgfTtcbn1cblxuZXhwb3J0IGNsYXNzIENsb3VkZnJvbnRDZG5UZW1wbGF0ZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3IoXG4gICAgc2NvcGU6IENvbnN0cnVjdCxcbiAgICBpZDogc3RyaW5nLFxuICAgIHByb3BzOiBDbG91ZGZyb250Q2RuVGVtcGxhdGVTdGFja1Byb3BzLFxuICApIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IHtcbiAgICAgIGJ1Y2tldE5hbWUsXG4gICAgICBhcHBOYW1lLFxuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICBjbG91ZGZyb250OiB7IGNvbW1lbnQgfSxcbiAgICAgIGVuZHBvaW50LFxuICAgICAgYXBpS2V5LFxuICAgICAgZGVwbG95TmFtZSxcbiAgICAgIGFwaVZlcnNpb24sXG4gICAgICBsYW5nZnVzZSxcbiAgICAgIGFudGhvcm9waWNBcGlLZXksXG4gICAgICBjbGF1ZGVNb2RlbCxcbiAgICAgIGxhbmdzbWl0aCxcbiAgICB9ID0gcHJvcHM7XG5cbiAgICBidWlsZEZyb250ZW5kKCk7XG5cbiAgICBjb25zdCBmdW5jdGlvbk5hbWUgPSBgJHtlbnZpcm9ubWVudCA/IGAke2Vudmlyb25tZW50fS1gIDogJyd9bGxtLXRzLWV4YW1wbGUtYXBpYDtcbiAgICBuZXcgYXdzbG9ncy5Mb2dHcm91cCh0aGlzLCAnQXBvbGxvTGFtYmRhRnVuY3Rpb25Mb2dHcm91cCcsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogYC9hd3MvbGFtYmRhLyR7ZnVuY3Rpb25OYW1lfWAsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgcmV0ZW50aW9uOiBhd3Nsb2dzLlJldGVudGlvbkRheXMuT05FX0RBWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRldk9wdGlvbnMgPSB7XG4gICAgICAvLyBlbnZpcm9ubWVudDoge1xuICAgICAgLy8gICBOT0RFX09QVElPTlM6ICctLWVuYWJsZS1zb3VyY2UtbWFwcycsXG4gICAgICAvLyB9LFxuICAgICAgLy8gYnVuZGxpbmc6IHtcbiAgICAgIC8vICAgc291cmNlTWFwOiB0cnVlLFxuICAgICAgLy8gICBzb3VyY2VNYXBNb2RlOiBub2RlanMuU291cmNlTWFwTW9kZS5CT1RILFxuICAgICAgLy8gICBzb3VyY2VzQ29udGVudDogdHJ1ZSxcbiAgICAgIC8vICAga2VlcE5hbWVzOiB0cnVlLFxuICAgICAgLy8gfSxcbiAgICAgIGFwcGxpY2F0aW9uTG9nTGV2ZWxWMjogbGFtYmRhLkFwcGxpY2F0aW9uTG9nTGV2ZWwuVFJBQ0UsXG4gICAgfTtcblxuICAgIGNvbnN0IGFwaVJvb3RQYXRoID0gJy9hcGkvJztcblxuICAgIGNvbnN0IGxhbmdmdXNlRW52ID0gbGFuZ2Z1c2UgPyB7XG4gICAgICBMQU5HRlVTRV9TRUNSRVRfS0VZOiBsYW5nZnVzZS5zayxcbiAgICAgIExBTkdGVVNFX1BVQkxJQ19LRVk6IGxhbmdmdXNlLnBrLFxuICAgICAgLi4uKGxhbmdmdXNlLmVuZHBvaW50ID8ge1xuICAgICAgICBMQU5HRlVTRV9CQVNFVVJMOiBsYW5nZnVzZS5lbmRwb2ludCxcbiAgICAgIH0gOiB7fSksXG4gICAgfSA6IHt9O1xuXG4gICAgY29uc3QgbGFuZ3NtaXRoRW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0gbGFuZ3NtaXRoID8ge1xuICAgICAgTEFOR0NIQUlOX1RSQUNJTkdfVjI6ICd0cnVlJyxcbiAgICAgIExBTkdDSEFJTl9FTkRQT0lOVDogbGFuZ3NtaXRoLmVuZHBvaW50LFxuICAgICAgTEFOR0NIQUlOX0FQSV9LRVk6IGxhbmdzbWl0aC5hcGlLZXksXG4gICAgICBMQU5HQ0hBSU5fUFJPSkVDVDogbGFuZ3NtaXRoLnByb2plY3QsXG4gICAgfSA6IHt9O1xuXG4gICAgY29uc3QgZm4gPSBuZXcgbm9kZWpzLk5vZGVqc0Z1bmN0aW9uKHRoaXMsICdMYW1iZGEnLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgIGFyY2hpdGVjdHVyZTogbGFtYmRhLkFyY2hpdGVjdHVyZS5BUk1fNjQsXG4gICAgICBlbnRyeTogJy4vbGFtYmRhL2luZGV4LnRzJyxcbiAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgIHJldHJ5QXR0ZW1wdHM6IDAsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAvLyAuLi5kZXZPcHRpb25zLmVudmlyb25tZW50LFxuICAgICAgICBBUElfUk9PVF9QQVRIOiBhcGlSb290UGF0aCxcbiAgICAgICAgQVpVUkVfT1BFTkFJX0FQSV9JTlNUQU5DRV9OQU1FOiBlbmRwb2ludCxcbiAgICAgICAgQVpVUkVfT1BFTkFJX0FQSV9ERVBMT1lNRU5UX05BTUU6IGRlcGxveU5hbWUsXG4gICAgICAgIEFaVVJFX09QRU5BSV9BUElfS0VZOiBhcGlLZXksXG4gICAgICAgIEFaVVJFX09QRU5BSV9BUElfVkVSU0lPTjogYXBpVmVyc2lvbixcbiAgICAgICAgQU5USFJPUElDX0FQSV9LRVk6IGFudGhvcm9waWNBcGlLZXksXG4gICAgICAgIENMQVVERV9NT0RFTDogY2xhdWRlTW9kZWwsXG4gICAgICAgIC4uLmxhbmdmdXNlRW52LFxuICAgICAgICAuLi5sYW5nc21pdGhFbnYsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgbWluaWZ5OiB0cnVlLFxuICAgICAgICAvLyAuLi5kZXZPcHRpb25zLmJ1bmRsaW5nLFxuICAgICAgfSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgcm9sZTogbmV3IGlhbS5Sb2xlKHRoaXMsICdBcG9sbG9MYW1iZGFGdW5jdGlvbkV4ZWN1dGlvblJvbGUnLCB7XG4gICAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdsYW1iZGEuYW1hem9uYXdzLmNvbScpLFxuICAgICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ0FXU0xhbWJkYUV4ZWN1dGUnKSxcbiAgICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ0Nsb3VkRnJvbnRSZWFkT25seUFjY2VzcycpLFxuICAgICAgICBdLFxuICAgICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICAgICdiZWRyb2NrLXBvbGljeSc6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsKicsXG4gICAgICAgICAgICAgICAgICAnbG9nczpQdXRMb2dFdmVudHMnLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBsb2dnaW5nRm9ybWF0OiBsYW1iZGEuTG9nZ2luZ0Zvcm1hdC5KU09OLFxuICAgICAgYXBwbGljYXRpb25Mb2dMZXZlbFYyOiBkZXZPcHRpb25zLmFwcGxpY2F0aW9uTG9nTGV2ZWxWMixcbiAgICB9KTtcblxuICAgIGNvbnN0IHMzYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnUzNCdWNrZXQnLCB7XG4gICAgICBidWNrZXROYW1lLFxuICAgICAgdmVyc2lvbmVkOiBmYWxzZSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBhdXRvRGVsZXRlT2JqZWN0czogdHJ1ZSxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHdlYnNpdGVJbmRleFBhZ2VGb3J3YXJkRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCAnV2Vic2l0ZUluZGV4UGFnZUZvcndhcmRGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ2xsbS10cy1leGFtcGxlLWFwaS1pbmRleC1mb3J3b3JkJyxcbiAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21GaWxlKHtcbiAgICAgICAgZmlsZVBhdGg6ICdmdW5jdGlvbi9pbmRleC5qcycsXG4gICAgICB9KSxcbiAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICB9KTtcbiAgICBjb25zdCBmdW5jdGlvbkFzc29jaWF0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgICBmdW5jdGlvbjogd2Vic2l0ZUluZGV4UGFnZUZvcndhcmRGdW5jdGlvbixcbiAgICAgIH0sXG4gICAgXTtcbiAgICBjb25zdCBvcmlnaW5BY2Nlc3NDb250cm9sID0gbmV3IGNsb3VkZnJvbnQuUzNPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMsICdTM09BQycsIHtcbiAgICAgIG9yaWdpbkFjY2Vzc0NvbnRyb2xOYW1lOiAnT0FDIGZvciBTMyAobGxtLXRzLWV4YW1wbGUtYXBpKScsXG4gICAgICBzaWduaW5nOiBjbG91ZGZyb250LlNpZ25pbmcuU0lHVjRfTk9fT1ZFUlJJREUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBjZiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCAnQ2xvdWRGcm9udCcsIHtcbiAgICAgIGNvbW1lbnQsXG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgb3JpZ2luOiBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHMzYnVja2V0LCB7XG4gICAgICAgICAgb3JpZ2luQWNjZXNzQ29udHJvbCxcbiAgICAgICAgICBvcmlnaW5BY2Nlc3NMZXZlbHM6IFtjbG91ZGZyb250LkFjY2Vzc0xldmVsLlJFQURdLFxuICAgICAgICAgIG9yaWdpbklkOiAnczMnLFxuICAgICAgICB9KSxcbiAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zLFxuXG4gICAgICB9LFxuICAgICAgYWRkaXRpb25hbEJlaGF2aW9yczoge1xuICAgICAgICBbYCR7YXBpUm9vdFBhdGh9KmBdOiB7XG4gICAgICAgICAgb3JpZ2luOiBuZXcgb3JpZ2lucy5GdW5jdGlvblVybE9yaWdpbihmbi5hZGRGdW5jdGlvblVybCh7XG4gICAgICAgICAgICBhdXRoVHlwZTogY2RrLmF3c19sYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNLFxuICAgICAgICAgICAgaW52b2tlTW9kZTogY2RrLmF3c19sYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU0sXG4gICAgICAgICAgfSksXG4gICAgICAgICAge1xuICAgICAgICAgICAgb3JpZ2luSWQ6ICdsYW1iZGEnLFxuICAgICAgICAgICAgcmVhZFRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeS5BTExfVklFV0VSX0VYQ0VQVF9IT1NUX0hFQURFUixcbiAgICAgICAgICByZXNwb25zZUhlYWRlcnNQb2xpY3k6IG5ldyBjZGsuYXdzX2Nsb3VkZnJvbnQuUmVzcG9uc2VIZWFkZXJzUG9saWN5KFxuICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICdSZXNwb25zZUhlYWRlcnNQb2xpY3knLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBjb3JzQmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgICBhY2Nlc3NDb250cm9sQWxsb3dPcmlnaW5zOiBbXG4gICAgICAgICAgICAgICAgICAnaHR0cDovL2xvY2FsaG9zdDo0MTczJyxcbiAgICAgICAgICAgICAgICAgICdodHRwOi8vbG9jYWxob3N0OjUxNzMnLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgYWNjZXNzQ29udHJvbEFsbG93SGVhZGVyczogWycqJ10sXG4gICAgICAgICAgICAgICAgYWNjZXNzQ29udHJvbEFsbG93TWV0aG9kczogWydBTEwnXSxcbiAgICAgICAgICAgICAgICBhY2Nlc3NDb250cm9sQWxsb3dDcmVkZW50aWFsczogZmFsc2UsXG4gICAgICAgICAgICAgICAgb3JpZ2luT3ZlcnJpZGU6IHRydWUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgaHR0cFZlcnNpb246IGNsb3VkZnJvbnQuSHR0cFZlcnNpb24uSFRUUDJfQU5EXzMsXG4gICAgfSk7XG5cbiAgICBjb25zdCBkZXBsb3lSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdEZXBsb3lXZWJzaXRlUm9sZScsIHtcbiAgICAgIHJvbGVOYW1lOiBgJHthcHBOYW1lfS1kZXBsb3ktcm9sZWAsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgICdzMy1wb2xpY3knOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogWydzMzoqJ10sXG4gICAgICAgICAgICAgIHJlc291cmNlczogW2Ake3MzYnVja2V0LmJ1Y2tldEFybn0vYCwgYCR7czNidWNrZXQuYnVja2V0QXJufS8qYF0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBuZXcgZGVwbG95bWVudC5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdEZXBsb3lXZWJzaXRlJywge1xuICAgICAgc291cmNlczogW2RlcGxveW1lbnQuU291cmNlLmFzc2V0KGAke3Byb2Nlc3MuY3dkKCl9Ly4uL2FwcC9kaXN0YCldLFxuICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHMzYnVja2V0LFxuICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6ICcvJyxcbiAgICAgIGV4Y2x1ZGU6IFsnLkRTX1N0b3JlJywgJyovLkRTX1N0b3JlJ10sXG4gICAgICBwcnVuZTogdHJ1ZSxcbiAgICAgIHJldGFpbk9uRGVsZXRlOiBmYWxzZSxcbiAgICAgIHJvbGU6IGRlcGxveVJvbGUsXG4gICAgfSk7XG5cbiAgICAvLyBPQUMgZm9yIExhbWJkYVxuICAgIGNvbnN0IGNmbk9yaWdpbkFjY2Vzc0NvbnRyb2wgPVxuICAgICAgbmV3IGNkay5hd3NfY2xvdWRmcm9udC5DZm5PcmlnaW5BY2Nlc3NDb250cm9sKFxuICAgICAgICB0aGlzLFxuICAgICAgICAnT3JpZ2luQWNjZXNzQ29udHJvbCcsXG4gICAgICAgIHtcbiAgICAgICAgICBvcmlnaW5BY2Nlc3NDb250cm9sQ29uZmlnOiB7XG4gICAgICAgICAgICBuYW1lOiBgT0FDIGZvciBMYW1iZGEgRnVuY3Rpb25zIFVSTCAoJHtmdW5jdGlvbk5hbWV9KWAsXG4gICAgICAgICAgICBvcmlnaW5BY2Nlc3NDb250cm9sT3JpZ2luVHlwZTogJ2xhbWJkYScsXG4gICAgICAgICAgICBzaWduaW5nQmVoYXZpb3I6ICdhbHdheXMnLFxuICAgICAgICAgICAgc2lnbmluZ1Byb3RvY29sOiAnc2lndjQnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICApO1xuXG4gICAgY29uc3QgY2ZuRGlzdHJpYnV0aW9uID0gY2Yubm9kZS5kZWZhdWx0Q2hpbGQgYXMgY2RrLmF3c19jbG91ZGZyb250LkNmbkRpc3RyaWJ1dGlvbjtcblxuICAgIC8vIFNldCBPQUMgZm9yIExhbWJkYVxuICAgIGNmbkRpc3RyaWJ1dGlvbi5hZGRQcm9wZXJ0eU92ZXJyaWRlKFxuICAgICAgJ0Rpc3RyaWJ1dGlvbkNvbmZpZy5PcmlnaW5zLjEuT3JpZ2luQWNjZXNzQ29udHJvbElkJyxcbiAgICAgIGNmbk9yaWdpbkFjY2Vzc0NvbnRyb2wuYXR0cklkLFxuICAgICk7XG5cbiAgICAvLyBBZGQgcGVybWlzc2lvbiBMYW1iZGEgRnVuY3Rpb24gVVJMc1xuICAgIGZuLmFkZFBlcm1pc3Npb24oJ0FsbG93Q2xvdWRGcm9udFNlcnZpY2VQcmluY2lwYWwnLCB7XG4gICAgICBwcmluY2lwYWw6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnY2xvdWRmcm9udC5hbWF6b25hd3MuY29tJyksXG4gICAgICBhY3Rpb246ICdsYW1iZGE6SW52b2tlRnVuY3Rpb25VcmwnLFxuICAgICAgc291cmNlQXJuOiBgYXJuOmF3czpjbG91ZGZyb250Ojoke2Nkay5TdGFjay5vZih0aGlzKS5hY2NvdW50fTpkaXN0cmlidXRpb24vJHtjZi5kaXN0cmlidXRpb25JZH1gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0FjY2Vzc1VSTE91dHB1dCcsIHtcbiAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke2NmLmRpc3RyaWJ1dGlvbkRvbWFpbk5hbWV9YCxcbiAgICB9KTtcbiAgfVxufVxuIl19