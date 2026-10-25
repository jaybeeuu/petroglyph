data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  # API Gateway invoke permissions are the one resource class whose correctness
  # depends on the account segment of an ARN, and the provider cannot supply it
  # here: the provider block below sets skip_requesting_account_id, so every ARN
  # the provider composes has an empty account. That makes
  # aws_apigatewayv2_api.petroglyph_api.execution_arn resolve to
  # arn:aws:execute-api:eu-west-2::j1k5ehldne, while API Gateway actually sends
  # arn:aws:execute-api:eu-west-2:<account-id>:j1k5ehldne/... . An ArnLike
  # condition against the account-less ARN never matches, the invoke is denied,
  # and API Gateway reports the denial as 500 Internal Server Error with no
  # Lambda invocation logged. So the ARN is assembled from the live identity
  # instead. Do not "simplify" this back to execution_arn.
  api_execution_arn = "arn:aws:execute-api:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:${aws_apigatewayv2_api.petroglyph_api.id}"

  # SSM parameters are namespaced by workspace so a second workspace (qa) cannot
  # collide with production. Resource names embed the workspace the same way
  # (petroglyph-<thing>-${terraform.workspace}); this brings SSM in line.
  ssm_parameter_prefix = "/petroglyph/${terraform.workspace}"

  # A Lambda SQS poller bills requests whether or not a message exists. QA is
  # idle except during CI, so its SQS mappings are disabled unless CI turns them
  # on. The workspace test short-circuits the variable: no deploy step can
  # disable production processing by setting `qa_quiesced`.
  sqs_esm_enabled = !(terraform.workspace == "qa" && var.qa_quiesced)
}

provider "aws" {
  region = "eu-west-2"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
}
