import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response, CookieOptions } from "express";
import type { AppConfig } from "@sdr/config";
import { APP_CONFIG } from "../config/config.module";
import { AuthService, type AuthTokens } from "./auth.service";
import { TokenService, type AccessClaims } from "./token.service";
import { CurrentUser, Public } from "./decorators";
import { LoginDto, SwitchTenantDto } from "./dto";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  // Rate-limit por IP (força bruta de credenciais): 10/min (override do default
  // global de 30). O ThrottlerModule é registrado no AppModule.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseGuards(ThrottlerGuard)
  @Public()
  @Post("login")
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; activeTenantId: string; tenants: unknown[] }> {
    const result = await this.auth.login(dto.email, dto.password);
    this.setAuthCookies(res, result);
    return {
      accessToken: result.accessToken,
      activeTenantId: result.activeTenantId,
      tenants: result.tenants,
    };
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseGuards(ThrottlerGuard)
  @Public()
  @Post("refresh")
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const token = this.refreshCookie(req);
    if (!token) throw new UnauthorizedException("Refresh token ausente.");
    let claims;
    try {
      claims = await this.tokens.verifyRefresh(token);
    } catch {
      throw new UnauthorizedException("Refresh token inválido.");
    }
    // ROTAÇÃO server-side (ADR 0006): o service valida a sessão (não-revogada/
    // não-expirada), revoga a apresentada e emite nova — reuso revoga tudo.
    const issued = await this.auth.refresh(claims);
    this.setAuthCookies(res, issued);
    return { accessToken: issued.accessToken };
  }

  @Post("switch-tenant")
  async switchTenant(
    @CurrentUser() user: AccessClaims,
    @Body() dto: SwitchTenantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    // Passa o refresh atual (cookie em path /auth) para o service revogar a
    // sessão antiga — o cookie será sobrescrito pelos tokens novos.
    const issued = await this.auth.switchTenant(user.sub, dto.tenantId, this.refreshCookie(req));
    this.setAuthCookies(res, issued);
    return { accessToken: issued.accessToken };
  }

  @Post("logout")
  async logout(
    @CurrentUser() user: AccessClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    // Revoga a SESSÃO do refresh apresentado (ADR 0006 — antes o logout só
    // limpava cookies e o refresh de 30d continuava válido). Best-effort: um
    // cookie ausente/inválido não impede a limpeza.
    await this.auth.logout(this.refreshCookie(req), user?.sub);
    // clearCookie precisa das MESMAS opções (path/domain) usadas ao setar,
    // senão o browser não remove — o refresh_token foi setado em path "/auth".
    const base = {
      domain: this.cfg.auth.cookieDomain,
      secure: this.cfg.auth.cookieSecure,
      sameSite: "lax" as const,
    };
    res.clearCookie("access_token", { ...base, path: "/" });
    res.clearCookie("refresh_token", { ...base, path: "/auth" });
    return { ok: true };
  }

  @Get("me")
  me(@CurrentUser() user: AccessClaims): AccessClaims {
    return user;
  }

  private refreshCookie(req: Request): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.refresh_token;
  }

  private setAuthCookies(res: Response, tokens: AuthTokens): void {
    const base: CookieOptions = {
      httpOnly: true,
      secure: this.cfg.auth.cookieSecure,
      sameSite: "lax",
      domain: this.cfg.auth.cookieDomain,
      path: "/",
    };
    res.cookie("access_token", tokens.accessToken, base);
    res.cookie("refresh_token", tokens.refreshToken, { ...base, path: "/auth" });
  }
}
