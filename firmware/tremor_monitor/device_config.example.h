// Shape of firmware/tremor_monitor/device_config.h, which tools/aws/provision-device.mjs GENERATES for your device
// (with its real endpoint, certificate and private key) and which is git-ignored. This example has fake values
// so the cloud code path can be compiled in CI. To use it: copy to device_config.h only to test-compile.
#pragma once
#define HTM_IOT_ENDPOINT   "abc123-ats.iot.ap-south-1.amazonaws.com"
#define HTM_THING_NAME     "htm-example"
#define HTM_OWNER_ID       "ap-south-1:11111111-2222-3333-4444-555555555555"
#define HTM_TOPIC_PREFIX   "tremor/v1/ap-south-1:11111111-2222-3333-4444-555555555555/htm-example/"
static const char HTM_ROOT_CA[]     = R"PEM(
-----BEGIN CERTIFICATE-----
EXAMPLE ONLY
-----END CERTIFICATE-----
)PEM";
static const char HTM_DEVICE_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
EXAMPLE ONLY
-----END CERTIFICATE-----
)PEM";
static const char HTM_PRIVATE_KEY[] = R"PEM(
-----BEGIN EXAMPLE KEY-----
EXAMPLE ONLY
-----END EXAMPLE KEY-----
)PEM";
