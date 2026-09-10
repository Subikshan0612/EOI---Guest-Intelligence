import { Router } from "express";
import { healthRoutes } from "./healthRoutes.js";
import { workspaceRoutes } from "./workspaceRoutes.js";
import { propertyRoutes } from "./propertyRoutes.js";
import { unitRoutes } from "./unitRoutes.js";
import { guestRoutes } from "./guestRoutes.js";
import { stayRoutes } from "./stayRoutes.js";
import { signalRoutes } from "./signalRoutes.js";
import { conversationRoutes } from "./conversationRoutes.js";
import { intelligenceRoutes } from "./intelligenceRoutes.js";
import { decisionRoutes } from "./decisionRoutes.js";
import { actionRoutes } from "./actionRoutes.js";
import { outcomeRoutes } from "./outcomeRoutes.js";

const apiRouter = Router();

apiRouter.use("/health", healthRoutes);
apiRouter.use("/workspaces", workspaceRoutes);
apiRouter.use("/properties", propertyRoutes);
apiRouter.use("/units", unitRoutes);
apiRouter.use("/guests", guestRoutes);
apiRouter.use("/stays", stayRoutes);
apiRouter.use("/signals", signalRoutes);
apiRouter.use("/conversations", conversationRoutes);
apiRouter.use("/intelligence", intelligenceRoutes);
apiRouter.use("/decisions", decisionRoutes);
apiRouter.use("/actions", actionRoutes);
apiRouter.use("/outcomes", outcomeRoutes);

export { apiRouter };
