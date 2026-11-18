import {
  MaintenanceBarrier,
  MaintenanceError,
} from '../maintenance-barrier.ts';

const [path, epoch] = process.argv.slice(2);
if (!path || !epoch || !process.send) throw new Error('Expected fixture IPC.');
const barrier = new MaintenanceBarrier(path, epoch);
process.on('message', () => {
  try {
    process.send?.({ claim: barrier.claim() });
  } catch (error) {
    if (!(error instanceof MaintenanceError)) throw error;
    process.send?.({ code: error.code });
  }
});
process.send({ ready: true });
