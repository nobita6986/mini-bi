/** Dang ky module hooks cho harness SSR. Dung qua: node --import <file> ... */
import { register } from "node:module";

register("./r3a-ssr-hooks.mjs", import.meta.url);
