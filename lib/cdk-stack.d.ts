import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface Config extends cdk.StackProps {
    bucketName: string;
    appName: string;
    cloudfront: {
        comment: string;
    };
}
interface CloudfrontCdnTemplateStackProps extends Config {
    environment?: string;
    endpoint: string;
    apiKey: string;
    deployName: string;
    apiVersion: string;
    langfuse?: {
        sk: string;
        pk: string;
        endpoint: string;
    };
    anthoropicApiKey: string;
    claudeModel: string;
    langsmith?: {
        apiKey: string;
        project: string;
        endpoint: string;
    };
}
export declare class CloudfrontCdnTemplateStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: CloudfrontCdnTemplateStackProps);
}
export {};
