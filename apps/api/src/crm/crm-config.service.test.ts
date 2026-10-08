import { describe, expect, it } from "vitest";
import { DEFAULT_CRM_SETTINGS, mergeCrmSettings } from "./crm-config.service";

describe("mergeCrmSettings (config do tenant não-confiável)", () => {
  it("default é builtin", () => {
    expect(mergeCrmSettings(DEFAULT_CRM_SETTINGS, {})).toMatchObject({ crmAdapter: "builtin" });
  });

  it("http sem baseURL cai para builtin (fail-safe)", () => {
    expect(mergeCrmSettings(DEFAULT_CRM_SETTINGS, { crmAdapter: "http" }).crmAdapter).toBe("builtin");
  });

  it("http com baseURL https público é aceito", () => {
    const s = mergeCrmSettings(DEFAULT_CRM_SETTINGS, {
      crmAdapter: "http",
      httpBaseURL: "https://crm.example.com/v1",
    });
    expect(s).toMatchObject({ crmAdapter: "http", httpBaseURL: "https://crm.example.com/v1" });
  });

  it("ANTI-SSRF: rejeita http, loopback, IP privado e metadata (cai p/ builtin)", () => {
    for (const url of [
      "http://crm.example.com/v1", // não-https
      "https://localhost/v1",
      "https://127.0.0.1/v1",
      "https://10.0.0.5/v1",
      "https://192.168.1.1/v1",
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://api.internal/v1",
    ]) {
      const s = mergeCrmSettings(DEFAULT_CRM_SETTINGS, { crmAdapter: "http", httpBaseURL: url });
      expect(s.crmAdapter, url).toBe("builtin");
      expect(s.httpBaseURL).toBeUndefined();
    }
  });

  it("ANTI-SSRF: rejeita hostname NUMÉRICO disfarçado (decimal/hex/octal/curto)", () => {
    for (const url of [
      "https://2130706433/v1", // decimal = 127.0.0.1
      "https://0x7f000001/v1", // hex = 127.0.0.1
      "https://0177.0.0.1/v1", // octal
      "https://127.1/v1", // forma curta
    ]) {
      const s = mergeCrmSettings(DEFAULT_CRM_SETTINGS, { crmAdapter: "http", httpBaseURL: url });
      expect(s.crmAdapter, url).toBe("builtin");
    }
  });

  it("ANTI-SSRF: rejeita faixas reservadas extras e IPv6 privado + porta não-padrão", () => {
    for (const url of [
      "https://100.64.0.1/v1", // CGNAT
      "https://198.18.0.1/v1", // benchmarking
      "https://0.0.0.0/v1", // this-network
      "https://[::1]/v1", // loopback IPv6
      "https://[fc00::1]/v1", // ULA IPv6
      "https://[fe80::1]/v1", // link-local IPv6
      "https://crm.example.com:8080/v1", // porta não-padrão
    ]) {
      const s = mergeCrmSettings(DEFAULT_CRM_SETTINGS, { crmAdapter: "http", httpBaseURL: url });
      expect(s.crmAdapter, url).toBe("builtin");
    }
  });

  it("aceita https público em porta 443 explícita", () => {
    const s = mergeCrmSettings(DEFAULT_CRM_SETTINGS, {
      crmAdapter: "http",
      httpBaseURL: "https://crm.example.com:443/v1",
    });
    expect(s.crmAdapter).toBe("http");
  });

  it("adapter desconhecido vira builtin; duração é clampada", () => {
    const s = mergeCrmSettings(DEFAULT_CRM_SETTINGS, { crmAdapter: "salesforce", appointmentDurationMin: 99999 });
    expect(s.crmAdapter).toBe("builtin");
    expect(s.appointmentDurationMin).toBe(480);
  });
});
