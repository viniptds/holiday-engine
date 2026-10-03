import { abortable, abortReason } from './abort.js';

describe('abortable', () => {
  it('passes the result through without a signal, or when nothing aborts', async () => {
    await expect(abortable(Promise.resolve(1), undefined)).resolves.toBe(1);
    await expect(abortable(Promise.resolve(2), new AbortController().signal)).resolves.toBe(2);
    await expect(abortable(Promise.reject(new Error('boom')), new AbortController().signal)).rejects.toThrow('boom');
  });

  it('rejects with the reason as soon as the signal aborts, ignoring the late result', async () => {
    const controller = new AbortController();
    let resolve!: (value: number) => void;
    const pending = abortable(new Promise<number>((r) => (resolve = r)), controller.signal);

    controller.abort(new Error('timed out after 5 ms'));
    resolve(3);

    await expect(pending).rejects.toThrow('timed out after 5 ms');
  });

  it('rejects at once for an already aborted signal', async () => {
    await expect(abortable(Promise.resolve(1), AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
  });

  it('turns a non-Error reason into an Error', () => {
    const controller = new AbortController();
    controller.abort('stop');
    expect(abortReason(controller.signal).message).toBe('stop');
  });
});
