import { Injectable } from "@nestjs/common";
import argon2 from "argon2";

/** Hashing de senha com argon2id (resistente a GPU; padrão OWASP). */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false; // hash malformado etc. — nunca lança para o chamador
    }
  }
}
