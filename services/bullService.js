import { Queue } from 'bullmq';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

let q = false;
export const bullService = {
    startQueue: (queueName = 'default') => {
        // if (q === false) {
        q = new Queue(queueName);
        return q;
        // }
        // return q;
    },

    pushJob: async (job) => {
        console.log('pushing job', job);
        console.log(q);
        await q.add(jobName, job);
    },

    consumeJob: async (queueName = 'default', processJob, onComplete = null, onFailed = null) => {
        const connection = new IORedis({ maxRetriesPerRequest: null });
        const worker = new Worker(queueName, async job => {
            console.log(job.data);
            return await processJob(job);
        },
            { connection },
        );

        worker.on('completed', job => {
            console.log(`${job.id} has completed!`);
            if (typeof onComplete === 'function') {
                onComplete(job);
            }
        });

        worker.on('failed', (job, err) => {
            console.log(`${job.id} has failed with ${err.message}`);
            if (typeof onFailed === 'function') {
                onFailed(job, err);
            }
        });
    }
}