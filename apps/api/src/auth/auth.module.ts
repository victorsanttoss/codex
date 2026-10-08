import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { TokenService } from "./token.service";

@Module({
  imports: [
    JwtModule.register({}), // segredos passados por chamada (access/refresh)
    // Rate-limit de credenciais: o ThrottlerModule é registrado (global) no
    // AppModule; login/refresh usam @Throttle(10/min) no controller.
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService],
  exports: [TokenService],
})
export class AuthModule {}
