import { getGuestById, getStayById } from "../../data/mockData";

export function getGuestContext(guestId, stayId) {
  return {
    guest: getGuestById(guestId),
    stay: getStayById(stayId),
  };
}
