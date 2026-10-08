import { Controller, Get, Query } from "@nestjs/common";
import { Roles } from "../auth/roles";
import { UsageRecorder } from "./usage.service";

@Controller("usage")
export class UsageController {
  constructor(private readonly usage: UsageRecorder) {}

  /** Uso agregado do tenant ativo num período. Requer papel admin+. */
  @Roles("admin")
  @Get()
  async summary(
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<{ from: string; to: string } & Awaited<ReturnType<UsageRecorder["aggregate"]>>> {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 3600_000);
    const agg = await this.usage.aggregate(fromDate, toDate);
    return { from: fromDate.toISOString(), to: toDate.toISOString(), ...agg };
  }
}
