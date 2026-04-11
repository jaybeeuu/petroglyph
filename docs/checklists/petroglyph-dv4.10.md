# petroglyph-dv4.10 checklist

This is the working checklist for applying the API layer in AWS and proving the public `/health` path end to end.

## Working steps

- [x] Authenticate to AWS with the `petroglyph-admin` profile in `eu-west-2`.
- [x] Confirm the bootstrap resources from the storage-layer work exist:
  - state bucket: `petroglyph-terraform-state-<ACCOUNT_ID>`
  - artifact bucket: `petroglyph-lambda-artifacts-<ACCOUNT_ID>`
  - lock table: `petroglyph-terraform-locks`
- [x] Build and package the API Lambda artifact:

```bash
pnpm --filter @petroglyph/api package
```

- [x] Upload the artifact to S3:

```bash
aws s3 cp packages/api/lambda.zip \
  s3://petroglyph-lambda-artifacts-<ACCOUNT_ID>/lambda-<UNIQUE>.zip \
  --profile petroglyph-admin \
  --region eu-west-2
```

- [x] Initialise Terraform in `packages/infra` if needed:

```bash
terraform init \
  -backend-config="bucket=petroglyph-terraform-state-<ACCOUNT_ID>" \
  -backend-config="key=petroglyph/terraform.tfstate" \
  -backend-config="region=eu-west-2" \
  -backend-config="dynamodb_table=petroglyph-terraform-locks" \
  -backend-config="encrypt=true"
```

- [x] Select the target workspace:

```bash
terraform workspace select production
```

- [x] Apply Terraform with the uploaded Lambda artifact:

```bash
terraform apply \
  -var="api_zip_s3_bucket=petroglyph-lambda-artifacts-<ACCOUNT_ID>" \
  -var="api_zip_s3_key=lambda-<UNIQUE>.zip"
```

## Acceptance checks

- [x] `terraform apply` completes without error.
- [x] `terraform output -raw api_endpoint` returns the public invoke URL.
- [x] `curl -i "$(terraform output -raw api_endpoint)/health"` returns HTTP 200 and `{"status":"ok"}`.
- [x] CloudWatch Lambda logs show the `/health` invocation within seconds in `/aws/lambda/petroglyph-api-<workspace>`.
- [x] API Gateway access logs show the `/health` request in `/aws/apigateway/petroglyph-<workspace>`.
- [x] A second `terraform apply` with the same vars reports no changes.

## Notes

- Keep the exact S3 object key you deploy with; the second apply must use the same key to prove idempotence.
- This bead is HITL because the live AWS apply and public endpoint verification need real account access.
- Deployed artifact key: `lambda-20260411085741-esm-fix.zip`
- Public API endpoint: `https://a02t0ypipa.execute-api.eu-west-2.amazonaws.com`
- Fixes required during execution:
  - include `package.json` in the Lambda zip so Node.js treats the bundle as ESM
  - grant Lambda roles permission to create log streams and put log events in CloudWatch Logs
