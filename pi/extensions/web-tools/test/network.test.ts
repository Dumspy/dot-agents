import { describe, expect, it } from "vitest";
import { classifyMimeType, isPrivateOrLocalIp, parseContentType } from "../network.ts";

describe("network", () => {
	it("parses content type for html and xhtml", () => {
		expect(parseContentType("TEXT/HTML; charset=UTF-8").kind).toBe("html");
		expect(parseContentType("TEXT/HTML; charset=UTF-8").mime).toBe("text/html");
		expect(parseContentType("application/xhtml+xml; charset=utf-8").kind).toBe("html");
		expect(parseContentType("image/svg+xml").kind).toBe("svg");
	});

	it("classifies mime types", () => {
		expect(classifyMimeType("image/png")).toBe("raster-image");
		expect(classifyMimeType("application/octet-stream")).toBe("binary");
		expect(classifyMimeType("application/json")).toBe("text");
	});

	it("detects private and local IPs", () => {
		expect(isPrivateOrLocalIp("127.0.0.1")).toBe(true);
		expect(isPrivateOrLocalIp("10.0.0.5")).toBe(true);
		expect(isPrivateOrLocalIp("192.168.1.20")).toBe(true);
		expect(isPrivateOrLocalIp("172.20.0.1")).toBe(true);
		expect(isPrivateOrLocalIp("::1")).toBe(true);
		expect(isPrivateOrLocalIp("fc00::1")).toBe(true);
		expect(isPrivateOrLocalIp("8.8.8.8")).toBe(false);
	});
});
