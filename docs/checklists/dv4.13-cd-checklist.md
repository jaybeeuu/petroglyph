# `petroglyph-dv4.13` checklist

This bead is the first live production CD verification. The goal is to prove the GitHub Actions deploy path works end to end and leaves production healthy.

The current workflow uses OIDC, not long-lived AWS keys. The required GitHub Actions secrets are configured on the `production` environment: `AWS_ROLE_ARN`, `TF_STATE_BUCKET`, and `LAMBDA_ARTIFACT_BUCKET`.

## Checklist

1. Confirm the production deployment prerequisites exist:
   - an AWS role that GitHub Actions can assume via OIDC
   - a Terraform state bucket
   - a Lambda artifact bucket
   - access to the GitHub `production` environment
2. Add or verify the `production` environment secrets:
   - `AWS_ROLE_ARN`
   - `TF_STATE_BUCKET`
   - `LAMBDA_ARTIFACT_BUCKET`
3. Confirm the `production` environment protection rules match the intended deploy flow:
   - only the `main` branch can deploy
   - deployments require manual review before the job proceeds
4. Make sure the branch you plan to merge is already green so the first `main` push exercises CD rather than unrelated failures.
5. Merge a PR to `main` to trigger `.github/workflows/cd.yml`.
6. Review and approve the protected `production` deployment when GitHub pauses the job for environment review.
7. Watch the `build`, `package`, and `deploy` jobs complete successfully.
8. In the `deploy` job, confirm:
   - OIDC authentication succeeds
   - `packages/api/lambda.zip` is uploaded to `s3://<LAMBDA_ARTIFACT_BUCKET>/lambda-<sha>.zip`
   - `terraform apply` completes in the `production` workspace
9. Verify the deployed `/health` endpoint returns `200`.
10. Make a second no-op or infra-neutral merge to `main`.
11. Review and approve the second protected deployment.
12. Confirm the second deploy is effectively a no-op from Terraform's point of view.
13. Close `petroglyph-dv4.13` once the evidence is captured. This unblocks `petroglyph-9jt.5`.

## Evidence to capture

- Link to the successful CD workflow run
- The commit SHA used for the first deploy
- Confirmation that the protected `production` deployment required review
- Confirmation that the Lambda artifact landed in the configured S3 bucket
- Confirmation that `/health` returned `200`
- Confirmation that the second deploy did not produce meaningful Terraform changes

## References

- `.github/workflows/cd.yml`
- `docs/ops.md`
- `CONTRIBUTING.md#cd-secrets`
