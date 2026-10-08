import { IsEmail, IsString, IsUUID, MinLength } from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class SwitchTenantDto {
  @IsUUID()
  tenantId!: string;
}
