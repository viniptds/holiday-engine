import express from 'express';
import { consumeJob, pushJob, startQueue } from './queue/telegramQueue.js';
const app = express()
const port = 3000

app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello World!')
})
app.post('/post-message', async (req, res) => {
    await pushJob(req.body);
    // console.log('HI');
    res.send('Hello World!')
})

startQueue();


const onSuccessfulJob = (job) => {
    console.log('Job completed', job);
}

// consumeJob(onSuccessfulJob, (job, err) => {
//     console.log('Job failed', job, err);
// });
consumeJob();
// consumeJob();

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
