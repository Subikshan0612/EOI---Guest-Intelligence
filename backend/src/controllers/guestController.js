import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as guestService from "../services/guestService.js";
import { actorHasPermission } from "../auth/authorize.js";
import { createGuestWithStay } from "../services/guestStayService.js";

export const createGuest = asyncHandler(async (req, res) => {
  const body = { ...req.body, workspaceId: req.actor.workspaceId };
  // A `stay` in the body creates the guest's first stay in the same request; without one this is the unchanged guest-only create.
  const data = body.stay === undefined ? await guestService.createGuest(body) : await createGuestWithStay(body, { canCreateUnit: actorHasPermission(req.actor, "workspace:admin") });
  sendSuccess(res, data, 201);
});

export const listGuests = asyncHandler(async (req, res) => {
  const { items, pagination } = await guestService.listGuests({ ...req.query, workspaceId: req.actor.workspaceId });
  sendList(res, items, pagination);
});

export const getGuest = asyncHandler(async (req, res) => {
  const data = await guestService.getGuestById(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const updateGuest = asyncHandler(async (req, res) => {
  const data = await guestService.updateGuest(req.params.id, req.body, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const deleteGuest = asyncHandler(async (req, res) => {
  const data = await guestService.deleteGuest(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});
