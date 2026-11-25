import { readEnvironment } from '../../../../server/environment';
import { loadCustomerSupportSettings } from '../../../../server/customer-support-settings';
import { createCustomerSupportSdkHandler } from '../../../../server/customer-support-sdk-proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
let handler: ReturnType<typeof createCustomerSupportSdkHandler> | undefined;
export function GET(request: Request) {
  handler ??= createCustomerSupportSdkHandler(loadCustomerSupportSettings(readEnvironment()).mode === 'libredesk');
  return handler(request);
}
