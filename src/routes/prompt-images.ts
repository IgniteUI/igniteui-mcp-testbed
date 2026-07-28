'use strict';

import * as fs from 'fs';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { PROMPT_IMAGES_DIR, PROMPT_IMAGE_MAX_BYTES, PROMPT_IMAGE_MAX_COUNT } from '../config.ts';
import { listImages, safeResolve, saveUpload, removeImage, isImageName, ensureImagesDir } from '../prompt-images.ts';

// Raw-bytes body for uploads: the browser POSTs the File object itself, so no multipart
// parser (and no new dependency) is needed. `type: () => true` accepts whatever
// Content-Type the file carries; the size cap is enforced here rather than after the
// whole image is buffered.
const rawImageBody = express.raw({ type: () => true, limit: PROMPT_IMAGE_MAX_BYTES });
function uploadBody(req: Request, res: Response, next: NextFunction): void {
  rawImageBody(req, res, (err: any) => {
    if (!err) return next();
    const tooBig = err.type === 'entity.too.large';
    res.status(tooBig ? 413 : 400).json({
      ok: false,
      error: tooBig
        ? `file is larger than the ${Math.round(PROMPT_IMAGE_MAX_BYTES / (1024 * 1024))} MB limit`
        : err.message,
    });
  });
}

export default function registerPromptImageRoutes(app: Express): void {
  // Reference images available to attach to a prompt, discovered under
  // PROMPT_IMAGES_DIR (bind-mounted ./prompt-images/, subfolders included). Names are
  // relative paths and double as the ids the wizard/matrix selections carry.
  app.get('/api/prompt-images', (_req, res) => {
    res.json({
      ok: true,
      dir: PROMPT_IMAGES_DIR,
      images: listImages(),
      maxBytes: PROMPT_IMAGE_MAX_BYTES,
      maxCount: PROMPT_IMAGE_MAX_COUNT,
    });
  });

  // Serve one image so the picker (and the History detail strip) can show thumbnails.
  // ?name= rather than a path param because names may contain subfolders.
  app.get('/api/prompt-images/file', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const abs = safeResolve(name);
    if (!abs || !isImageName(abs)) {
      res.status(400).json({ ok: false, error: 'invalid image name' });
      return;
    }
    if (!fs.existsSync(abs)) {
      res.status(404).json({ ok: false, error: 'image not found' });
      return;
    }
    res.sendFile(abs);
  });

  // Upload an image into the host folder (so it persists there and a later
  // terminal-driven config can reference it by name). Body = raw file bytes.
  app.post('/api/prompt-images', uploadBody, (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    try {
      ensureImagesDir();
      const stored = saveUpload(name, req.body as Buffer);
      res.json({ ok: true, name: stored });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Remove an image from the host folder. Deliberately a real delete — the folder IS
  // the user's working set — so the UI confirms first.
  app.delete('/api/prompt-images', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!removeImage(name)) {
      res.status(404).json({ ok: false, error: 'image not found' });
      return;
    }
    res.json({ ok: true });
  });
}
