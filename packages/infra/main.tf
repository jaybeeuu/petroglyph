locals {
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
