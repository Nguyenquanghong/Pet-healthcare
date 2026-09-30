import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { BusinessError } from "../domain/error.js";
import type { PaymentsService } from "../application/services/payments.js";

export function createPaymentsRouter(service: PaymentsService) {
  const router = Router();
  router.get("/vnpay/ipn", async (req, res) => {
    try { res.json(await service.ipn(req.query)); }
    catch { res.json({ RspCode: "99", Message: "Unable to confirm; retry" }); }
  });
  router.get("/vnpay/return", (req, res) => res.json(service.verifyReturn(req.query)));
  router.use(requireAuth);
  router.get("/options", (_req, res) => res.json(service.options()));
  router.post("/:id/reconcile", async (req, res) => {
    try { res.json(await service.reconcile(req.auth!, req.params.id, req.ip || "127.0.0.1")); }
    catch (error) {
      if (error instanceof BusinessError) { res.status(error.status).json({ error: error.message }); return; }
      throw error;
    }
  });
  router.post("/:id/vnpay", async (req, res) => {
    try { res.json(await service.start(req.auth!, req.params.id, req.ip || "127.0.0.1")); }
    catch (error) {
      if (error instanceof BusinessError) { res.status(error.status).json({ error: error.message }); return; }
      throw error;
    }
  });
  return router;
}
