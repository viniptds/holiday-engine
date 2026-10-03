import { bullService } from '../services/bullService.js';

const queueName = 'telegram';
const jobName = 'telegramJob';
let queue = false;

export const startQueue = () => {
    if (queue === false) {
        // queue = new Queue(queueName);
        queue = bullService.startQueue(queueName);
        return queue;
    }
    return queue;
}

export const pushJob = async (job) => {
    console.log('pushing job', job);
    await queue.add(jobName, job);
}

export const consumeJob = async () => {

    const processJob = async (job) => {
        console.log('processing job', job);
        // await
    }
    const onComplete = null;
    const onFailed = null;
    
    bullService.consumeJob(queueName, processJob, onComplete, onFailed);

}
