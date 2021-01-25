/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Config } from '@backstage/config';
import os from 'os';
import fs from 'fs-extra';
import Docker from 'dockerode';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import {
  JobProcessor,
  PreparerBuilder,
  StageContext,
  TemplaterBuilder,
  TemplaterValues,
  PublisherBuilder,
  parseLocationAnnotation,
  FilePreparer,
} from '../scaffolder';
import { CatalogEntityClient } from '../lib/catalog';
import { validate, ValidatorResult } from 'jsonschema';
import parseGitUrl from 'git-url-parse';
import {
  MemoryTaskBroker,
  MemoryDatabase,
  TaskWorker,
} from '../scaffolder/tasks';

export interface RouterOptions {
  preparers: PreparerBuilder;
  templaters: TemplaterBuilder;
  publishers: PublisherBuilder;

  logger: Logger;
  config: Config;
  dockerClient: Docker;
  entityClient: CatalogEntityClient;
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const router = Router();
  router.use(express.json());

  const {
    preparers,
    templaters,
    publishers,
    logger: parentLogger,
    config,
    dockerClient,
    entityClient,
  } = options;

  const logger = parentLogger.child({ plugin: 'scaffolder' });

  let workingDirectory = os.tmpdir();
  if (config.has('backend.workingDirectory')) {
    workingDirectory = config.getString('backend.workingDirectory');
    try {
      // Check if working directory exists and is writable
      await fs.promises.access(
        workingDirectory,
        fs.constants.F_OK | fs.constants.W_OK,
      );
      logger.info(`using working directory: ${workingDirectory}`);
    } catch (err) {
      logger.error(
        `working directory ${workingDirectory} ${
          err.code === 'ENOENT' ? 'does not exist' : 'is not writable'
        }`,
      );
      throw err;
    }
  }

  const jobProcessor = new JobProcessor();
  const taskBroker = new MemoryTaskBroker(new MemoryDatabase());
  const worker = new TaskWorker({
    logger,
    taskBroker,
    workingDirectory,
    dockerClient,
    entityClient,
    preparers,
    publishers,
    templaters,
  });
  worker.start();

  router
    .get('/v1/job/:jobId', ({ params }, res) => {
      const job = jobProcessor.get(params.jobId);

      if (!job) {
        res.status(404).send({ error: 'job not found' });
        return;
      }

      res.send({
        id: job.id,
        metadata: {
          ...job.context,
          logger: undefined,
          logStream: undefined,
        },
        status: job.status,
        stages: job.stages.map(stage => ({
          ...stage,
          handler: undefined,
        })),
        error: job.error,
      });
    })
    // curl -X POST -d '{"templateName":"springboot-template","values": {"storePath":"https://github.com/jhaals/foo", "component_id":"woop", "description": "apa", "owner": "me" }}' -H 'Content-Type: application/json' localhost:7000/api/scaffolder/v2/tasks
    .post('/v2/tasks', async (req, res) => {
      const templateName: string = req.body.templateName;
      const values: TemplaterValues = {
        ...req.body.values,
        destination: {
          git: parseGitUrl(req.body.values.storePath),
        },
      };
      const template = await entityClient.findTemplate(templateName);

      const validationResult: ValidatorResult = validate(
        values,
        template.spec.schema,
      );

      if (!validationResult.valid) {
        res.status(400).json({ errors: validationResult.errors });
        return;
      }
      const result = await taskBroker.dispatch({
        template,
        values,
      });

      res.status(201).json({ id: result.taskId });
    })

    .get('/v2/tasks/:taskId/eventstream', async (req, res) => {
      const { taskId } = req.params;
      const after = Number(req.query.after) || undefined;
      logger.info('event stream opened');

      // Mandatory headers and http status to keep connection open
      res.writeHead(200, {
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      });
      // After client opens connection send all nests as string
      const unsubscribe = taskBroker.observe(
        { taskId, after },
        ({ events }) => {
          for (const event of events) {
            res.write(`event:${JSON.stringify(event)}\n\n`);
            if (event.type === 'completion') {
              unsubscribe();
              res.end();
            }
          }
        },
      );
      // When client closes connection we update the clients list
      // avoiding the disconnected one
      req.on('close', () => {
        unsubscribe();
        logger.info('event stream closed');
      });
    })

    .post('/v1/jobs', async (req, res) => {
      const templateName: string = req.body.templateName;
      const values: TemplaterValues = {
        ...req.body.values,
        destination: {
          git: parseGitUrl(req.body.values.storePath),
        },
      };

      const template = await entityClient.findTemplate(templateName);

      const validationResult: ValidatorResult = validate(
        values,
        template.spec.schema,
      );

      if (!validationResult.valid) {
        res.status(400).json({ errors: validationResult.errors });
        return;
      }
      const job = jobProcessor.create({
        entity: template,
        values,
        stages: [
          {
            name: 'Prepare the skeleton',
            handler: async ctx => {
              const { protocol, location: pullPath } = parseLocationAnnotation(
                ctx.entity,
              );

              const preparer =
                protocol === 'file'
                  ? new FilePreparer()
                  : preparers.get(pullPath);

              const skeletonDir = await preparer.prepare(ctx.entity, {
                logger: ctx.logger,
                workingDirectory,
              });
              return { skeletonDir };
            },
          },
          {
            name: 'Run the templater',
            handler: async (ctx: StageContext<{ skeletonDir: string }>) => {
              const templater = templaters.get(ctx.entity);
              const { resultDir } = await templater.run({
                directory: ctx.skeletonDir,
                dockerClient,
                logStream: ctx.logStream,
                values: ctx.values,
              });

              return { resultDir };
            },
          },
          {
            name: 'Publish template',
            handler: async (ctx: StageContext<{ resultDir: string }>) => {
              const publisher = publishers.get(ctx.values.storePath);
              ctx.logger.info('Will now store the template');
              const result = await publisher.publish({
                values: ctx.values,
                directory: ctx.resultDir,
                logger: ctx.logger,
              });
              return result;
            },
          },
        ],
      });

      jobProcessor.run(job);

      res.status(201).json({ id: job.id });
    });

  const app = express();
  app.set('logger', logger);
  app.use('/', router);

  return app;
}
