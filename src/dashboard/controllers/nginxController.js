import {
  getStatus,
  reload,
  restart,
  start,
  stop,
  test,
  listConfigs,
  getConfig,
  saveConfig,
  getLogs,
  NginxNotFoundError,
  NginxConfigError,
  InvalidFilenameError,
} from '../../core/nginx-service.js';

class NginxController {
  handleError(err, res) {
    if (err instanceof NginxNotFoundError) {
      return res.status(503).json({ error: 'nginx not installed' });
    }
    if (err instanceof NginxConfigError) {
      return res.status(400).json({ success: false, output: err.output });
    }
    if (err instanceof InvalidFilenameError) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Config file not found' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }

  async status(req, res, next) {
    try {
      const status = await getStatus();
      res.json(status);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async reload(req, res, next) {
    try {
      const result = await reload();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async restart(req, res, next) {
    try {
      const result = await restart();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async start(req, res, next) {
    try {
      const result = await start();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async stop(req, res, next) {
    try {
      const result = await stop();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async test(req, res, next) {
    try {
      const result = await test();
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async listConfigs(req, res, next) {
    try {
      const configs = await listConfigs();
      res.json(configs);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async getConfig(req, res, next) {
    try {
      const result = await getConfig(req.params.filename);
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  async saveConfig(req, res, next) {
    try {
      if (typeof req.body.content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      const result = await saveConfig(req.params.filename, req.body.content);
      res.json(result);
    } catch (err) {
      this.handleError(err, res);
    }
  }

  /**
   * GET /api/nginx/logs?file=error|access&lines=N
   *
   * Both parameters are additive: the previous endpoint took none and always
   * returned 100 lines of the ERROR log, which is what the defaults still do.
   * The access log was simply unreachable before — the contract has always
   * described this endpoint as "access/error lines", so the gap was here.
   *
   * `file` is echoed back so a client cannot mistake which log it is showing.
   */
  async getLogs(req, res, next) {
    try {
      const which = req.query?.file === 'access' ? 'access' : 'error';

      // Clamped rather than rejected, matching the clamp in core/runner.js for
      // process logs: an out-of-range number is a client bug, not a reason to
      // show the operator an error instead of their logs.
      const requested = Number(req.query?.lines);
      const lines = Math.max(1, Math.min(5000, Number.isFinite(requested) ? requested : 100));

      const result = await getLogs(lines, which);
      res.json({ ...result, file: which });
    } catch (err) {
      this.handleError(err, res);
    }
  }
}

export default NginxController;
