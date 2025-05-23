const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const { capitalize } = require('./utils');

const execAsync = util.promisify(exec);

/**
 * @description Add warmer role to service
 * */
function addWarmUpFunctionRoleToResources(service, stage, warmerName, warmerConfig) {
  // eslint-disable-next-line no-param-reassign
  warmerConfig.role = `WarmUpPlugin${capitalize(warmerName)}Role`;
  if (typeof service.resources !== 'object') {
    // eslint-disable-next-line no-param-reassign
    service.resources = {};
  }
  if (typeof service.resources.Resources !== 'object') {
    // eslint-disable-next-line no-param-reassign
    service.resources.Resources = {};
  }

  // eslint-disable-next-line no-param-reassign
  service.resources.Resources[warmerConfig.role] = {
    Type: 'AWS::IAM::Role',
    Properties: {
      Path: '/',
      RoleName: warmerConfig.roleName || {
        'Fn::Join': [
          '-',
          [service.service, stage, { Ref: 'AWS::Region' }, warmerName.toLowerCase(), 'role'],
        ],
      },
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: ['lambda.amazonaws.com'],
            },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      Policies: [
        {
          PolicyName: {
            'Fn::Join': [
              '-',
              [service.service, stage, 'warmer', warmerName.toLowerCase(), 'policy'],
            ],
          },
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['logs:CreateLogGroup', 'logs:CreateLogStream'],
                Resource: [
                  {
                    'Fn::Sub': `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${warmerConfig.name}:*`,
                  },
                ],
              },
              {
                Effect: 'Allow',
                Action: ['logs:PutLogEvents'],
                Resource: [
                  {
                    'Fn::Sub': `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${warmerConfig.name}:*:*`,
                  },
                ],
              },
              {
                Effect: 'Allow',
                Action: ['lambda:InvokeFunction'],
                Resource: warmerConfig.functions.map((fn) => ({
                  'Fn::Sub': `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${fn.name}*`,
                })),
              },
              {
                Effect: 'Allow',
                Action: [
                  'ec2:CreateNetworkInterface',
                  'ec2:DescribeNetworkInterfaces',
                  'ec2:DetachNetworkInterface',
                  'ec2:DeleteNetworkInterface',
                ],
                Resource: '*',
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * @description Create warm up function code and write it to the handler file
 *
 * @param {Array} functions - Functions to be warmed up
 *
 * @fulfil {} — Warm up function created
 * @reject {Error} Warm up error
 *
 * @return {Promise}
 * */
async function createWarmUpFunctionArtifact(functions, tracing, verbose, region, handlerFolder) {
  const warmUpFunction = `
/** Generated by Serverless WarmUp Plugin **/

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const uninstrumentedLambdaClient = new LambdaClient({
  apiVersion: '2015-03-31',
  region: '${region}',
  requestHandler: new NodeHttpHandler({ connectionTimeout: 1000 }),
});

${
  tracing
    ? `import * as AWSXRay from 'aws-xray-sdk';
const lambdaClient = AWSXRay.captureAWSv3Client(uninstrumentedLambdaClient);`
    : 'const lambdaClient = uninstrumentedLambdaClient;'
}

const functions = ${JSON.stringify(functions, null, '  ')};

function logVerbose(str) {
  ${verbose ? 'console.log(str);' : ''}
}

function getConcurrency(func, envVars) {
  const functionConcurrency = envVars[\`WARMUP_CONCURRENCY_\${func.name.toUpperCase().replace(/-/g, '_')}\`];

  if (functionConcurrency) {
    const concurrency = parseInt(functionConcurrency);
    logVerbose(\`Warming up function: \${func.name} with concurrency: \${concurrency} (from function-specific environment variable)\`);
    return concurrency;
  }

  if (envVars.WARMUP_CONCURRENCY) {
    const concurrency = parseInt(envVars.WARMUP_CONCURRENCY);
    logVerbose(\`Warming up function: \${func.name} with concurrency: \${concurrency} (from global environment variable)\`);
    return concurrency;
  }

  const concurrency = parseInt(func.config.concurrency);
  logVerbose(\`Warming up function: \${func.name} with concurrency: \${concurrency}\`);
  return concurrency;
}

export const warmUp = async (event, context) => {
  logVerbose('Warm Up Start');

  const invokes = await Promise.all(functions.map(async (func) => {
    const concurrency = getConcurrency(func, process.env);

    const clientContext = func.config.clientContext !== undefined
      ? func.config.clientContext
      : func.config.payload;

    const invokeCommand = new InvokeCommand({
      ClientContext: clientContext
        ? Buffer.from(\`{"custom":\${clientContext}}\`).toString('base64')
        : undefined,
      FunctionName: func.name,
      InvocationType: 'RequestResponse',
      LogType: 'None',
      Qualifier: func.config.alias || process.env.SERVERLESS_ALIAS,
      Payload: func.config.payload
    });

    try {
      await Promise.all(Array(concurrency).fill(0).map(async () => await lambdaClient.send(invokeCommand)));
      logVerbose(\`Warm Up Invoke Success: \${func.name}\`);
      return true;
    } catch (e) {
      console.error(\`Warm Up Invoke Error: \${func.name}\`, e);
      return false;
    }
  }));

  logVerbose(\`Warm Up Finished with \${invokes.filter(r => !r).length} invoke errors\`);
}`;

  /** Write warm up file */
  await fs.mkdir(handlerFolder, { recursive: true });
  await fs.writeFile(path.join(handlerFolder, 'index.mjs'), warmUpFunction);

  if (tracing) {
    await execAsync('npm init -y', { cwd: handlerFolder });
    await execAsync('npm install --save aws-xray-sdk-core', { cwd: handlerFolder });
  }
}

/**
 * @description Add warmer function to service
 * */
function addWarmUpFunctionToService(service, warmerName, warmerConfig) {
  // eslint-disable-next-line no-param-reassign
  service.functions[`warmUpPlugin${capitalize(warmerName)}`] = {
    description: `Serverless WarmUp Plugin (warmer "${warmerName}")`,
    events: warmerConfig.events,
    handler: warmerConfig.pathHandler.split(path.sep).join(path.posix.sep),
    memorySize: warmerConfig.memorySize,
    name: warmerConfig.name,
    ...(warmerConfig.architecture ? { architecture: warmerConfig.architecture } : {}),
    runtime: 'nodejs22.x',
    package: warmerConfig.package,
    timeout: warmerConfig.timeout,
    ...(Object.keys(warmerConfig.environment).length
      ? { environment: warmerConfig.environment }
      : {}),
    ...(warmerConfig.tracing !== undefined ? { tracing: warmerConfig.tracing } : {}),
    ...(warmerConfig.logRetentionInDays !== undefined
      ? { logRetentionInDays: warmerConfig.logRetentionInDays }
      : {}),
    ...(warmerConfig.roleName ? { roleName: warmerConfig.roleName } : {}),
    ...(warmerConfig.role ? { role: warmerConfig.role } : {}),
    ...(warmerConfig.tags ? { tags: warmerConfig.tags } : {}),
    ...(warmerConfig.vpc ? { vpc: warmerConfig.vpc } : {}),
    layers: [],
  };
}

module.exports = {
  addWarmUpFunctionRoleToResources,
  createWarmUpFunctionArtifact,
  addWarmUpFunctionToService,
};
