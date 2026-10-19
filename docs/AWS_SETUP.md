# AWS setup guide

Status: **written and verified in milestone 6.** It is written for someone with a new AWS account who has never used IoT Core, on Windows with the Arduino IDE. Outline:

1. Secure the account: MFA on root, an admin user through IAM Identity Center, budget and billing alerts.
2. Install the AWS CLI (already present: aws-cli 2.x) and run the CDK through `npx`.
3. Deploy the stack, read the outputs.
4. Provision the device certificate and put it on the ESP32 safely.
5. Flash, watch the MQTT test client, see rows in DynamoDB.
6. Open the app, sign in, see live data and history.
7. Run the simulator against the cloud without hardware.
8. Read the bill and free-tier usage; tear everything down.
9. Troubleshooting table.
