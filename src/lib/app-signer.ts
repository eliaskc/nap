import { Container } from "@cloudflare/containers";

/**
 * The app signer: a Cloudflare Container (containers/signer) that signs unsigned iOS builds with
 * rcodesign. Nap never builds apps; it only signs them, so the certificate never leaves Nap.
 *
 * The certificate reaches the container as an environment variable when it starts. The container
 * has no internet access. One instance signs everything and sleeps when idle.
 */
export class AppSigner extends Container<Cloudflare.Env> {
  defaultPort = 8080;
  sleepAfter = "3m";
  enableInternet = false;

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    super(ctx, env);
    const pem = String(env.NAP_APPLE_SIGNING_PEM ?? "");
    this.envVars = { SIGNING_PEM: pem.replace(/\\n/g, "\n") };
  }
}
