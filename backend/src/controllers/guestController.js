import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as guestService from "../services/guestService.js";

export const createGuest = asyncHandler(async (req, res) => {
  const data = await guestService.createGuest(req.body);
  sendSuccess(res, data, 201);
});

export const listGuests = asyncHandler(async (req, res) => {
  const { items, pagination } = await guestService.listGuests(req.query);
  sendList(res, items, pagination);
});

export const getGuest = asyncHandler(async (req, res) => {
  const data = await guestService.getGuestById(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const updateGuest = asyncHandler(async (req, res) => {
  const data = await guestService.updateGuest(req.params.id, req.body, req.query.workspaceId);
  sendSuccess(res, data);
});

export const deleteGuest = asyncHandler(async (req, res) => {
  const data = await guestService.deleteGuest(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});
