import {
	ReadonlyProvider,
	RealFSProvider,
	ShadowProvider,
	type VirtualProvider,
} from "@earendil-works/gondolin";
import { isProtectedRelativePath } from "../paths.js";
import type { AccessMode } from "../types.js";

export function createHostDirectoryProvider(options: {
	hostPath: string;
	mode: AccessMode;
	additionalProtectedPaths?: readonly string[];
}): VirtualProvider {
	const real = new RealFSProvider(options.hostPath);
	const protectedProvider = new ShadowProvider(real, {
		shouldShadow: (context) => isProtectedRelativePath(context.path, options.additionalProtectedPaths),
		writeMode: "deny",
		denySymlinkBypass: true,
	});
	return options.mode === "read-only" ? new ReadonlyProvider(protectedProvider) : protectedProvider;
}
