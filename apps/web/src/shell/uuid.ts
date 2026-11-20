// apps/web/src/shell — whether a string from outside (a query parameter, a pasted id) has the shape of a UUID, before it is trusted as an id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);
