import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { AllowPendingMfa, Auth, Public } from '../../common/decorators';
import { AuthInfo, clientIp, KoraRequest } from '../../common/request-context';
import { email, parse, password } from '../../common/validation';
import { AuthService } from './auth.service';

const SignupSchema = z.object({
  fullName: z.string().trim().min(2, { message: 'Indiquez votre nom complet' }).max(120),
  email, password,
  companyName: z.string().trim().min(2, { message: "Indiquez le nom de l'entreprise" }).max(160),
});
const LoginSchema = z.object({ email, password: z.string().min(1).max(200), code: z.string().regex(/^\d{6}$/).optional() });
const CodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, { message: 'Le code comporte 6 chiffres' }) });

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(config.session.cookieName, token, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', expires: expiresAt });
}

@ApiTags('Authentification')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @UseGuards(ThrottlerGuard)
  @Post('signup')
  async signup(@Body() body: unknown, @Req() req: KoraRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(SignupSchema, body);
    const r = await this.auth.signup(input, { ip: clientIp(req), ua: req.headers['user-agent'] ?? null });
    setSessionCookie(res, r.session.token, r.session.expiresAt);
    return { userId: r.userId, companyId: r.companyId };
  }

  @Public() @UseGuards(ThrottlerGuard) @HttpCode(200)
  @Post('login')
  async login(@Body() body: unknown, @Req() req: KoraRequest, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(parse(LoginSchema, body), { ip: clientIp(req), ua: req.headers['user-agent'] ?? null });
    setSessionCookie(res, r.session.token, r.session.expiresAt);
    return { mfaRequired: r.mfaRequired };
  }

  @AllowPendingMfa() @UseGuards(ThrottlerGuard) @HttpCode(200)
  @Post('mfa/verify')
  async verifyMfa(@Auth() auth: AuthInfo, @Body() body: unknown) {
    await this.auth.verifyMfa(auth, parse(CodeSchema, body).code);
    return { ok: true };
  }

  @Post('mfa/setup') @HttpCode(200)
  setupMfa(@Auth() auth: AuthInfo) { return this.auth.setupMfa(auth); }

  @Post('mfa/enable') @HttpCode(200)
  async enableMfa(@Auth() auth: AuthInfo, @Body() body: unknown) {
    await this.auth.enableMfa(auth, parse(CodeSchema, body).code);
    return { ok: true };
  }

  @AllowPendingMfa() @HttpCode(200)
  @Post('logout')
  async logout(@Auth() auth: AuthInfo, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth);
    res.clearCookie(config.session.cookieName, { path: '/' });
    return { ok: true };
  }

  @AllowPendingMfa()
  @Get('me')
  me(@Auth() auth: AuthInfo) { return this.auth.me(auth); }

  @Post('switch-company') @HttpCode(200)
  async switchCompany(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: KoraRequest) {
    const { companyId } = parse(z.object({ companyId: z.string() }), body);
    await this.auth.switchCompany(auth, companyId, clientIp(req));
    return { activeCompanyId: companyId };
  }

  @Post('password') @HttpCode(200)
  async changePassword(@Auth() auth: AuthInfo, @Body() body: unknown) {
    const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), body);
    await this.auth.changePassword(auth, b.currentPassword, b.newPassword);
    return { ok: true };
  }

  @Get('sessions')
  sessions(@Auth() auth: AuthInfo) { return this.auth.listSessions(auth); }

  @Delete('sessions/:id')
  async revoke(@Auth() auth: AuthInfo, @Param('id') id: string) {
    await this.auth.revokeSession(auth, id);
    return { ok: true };
  }
}
