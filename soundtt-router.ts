import { Router } from 'express';
import { SoundttService } from './soundtt-service.js';

export function createSoundttRouter(service: SoundttService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/jobs', (req, res) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ success: false, error: 'Akses cross-origin tidak diizinkan' });
    }
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) throw new Error('origin');
      } catch {
        return res.status(403).json({ success: false, error: 'Origin tidak diizinkan' });
      }
    }
    if (!req.is('application/json')) {
      return res.status(415).json({ success: false, error: 'Gunakan Content-Type application/json' });
    }
    const result = service.createJob(req.body?.urls);
    if (result.success === false) {
      return res.status(result.code === 'QUEUE_FULL' ? 429 : 400).json(result);
    }
    return res.status(202).json({ success: true, job: service.getPublicJobView(result.job) });
  });

  router.get('/jobs/:jobId', (req, res) => {
    const job = service.getJob(String(req.params.jobId));
    if (!job) return res.status(404).json({ success: false, error: 'Antrean tidak ditemukan atau sudah kedaluwarsa' });
    return res.json({ success: true, job: service.getPublicJobView(job) });
  });

  router.get('/jobs/:jobId/items/:itemId/download', (req, res) => {
    const jobId = String(req.params.jobId);
    const itemId = String(req.params.itemId);
    const job = service.getJob(jobId);
    const item = job?.items.find(entry => entry.id === itemId);
    if (!item) return res.status(404).json({ success: false, error: 'Sound tidak ditemukan atau sudah kedaluwarsa' });
    if (item.status !== 'ready') return res.status(409).json({ success: false, error: 'File WAV belum tersedia' });
    const file = service.getItemFile(jobId, itemId);
    if (!file) return res.status(404).json({ success: false, error: 'File WAV sudah tidak tersedia' });
    service.retainDownload(file.filePath);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      service.releaseDownload(file.filePath);
    };
    res.once('close', release);
    res.once('finish', release);
    res.type('audio/wav');
    res.download(file.filePath, file.filename, error => {
      release();
      if (error && !res.headersSent) res.status(500).json({ success: false, error: 'Gagal mengunduh file WAV' });
      else if (error) res.destroy();
    });
  });

  return router;
}
