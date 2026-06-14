// FIXTURE — defines a table owned by M12 (medication_order).
import { pgTable, uuid } from "drizzle-orm/pg-core";
export const medicationOrder = pgTable("medication_order", { id: uuid("id").primaryKey() })
