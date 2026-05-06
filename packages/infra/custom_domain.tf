# ---------------------------------------------------------------------------
# Custom domain for the API
#
# Gated on var.api_custom_domain — set it to e.g. "api.petroglyph.page" to
# activate. When empty, no resources are created and CD continues to use the
# raw execute-api URL.
#
# HITL steps required the first time:
#   1. Run terraform apply with api_custom_domain set — creates the ACM cert
#      in PENDING_VALIDATION state and outputs the validation CNAME.
#   2. Add the validation CNAME to your DNS provider (e.g. Cloudflare).
#   3. Wait for the cert to reach ISSUED (~2 min).
#   4. Run terraform apply again — creates the API GW custom domain + mapping
#      and outputs the regional target CNAME.
#   5. Add a CNAME record in Cloudflare: api.petroglyph.page → target.
# ---------------------------------------------------------------------------

locals {
  has_custom_domain = var.api_custom_domain != ""
}

resource "aws_acm_certificate" "api" {
  count             = local.has_custom_domain ? 1 : 0
  domain_name       = var.api_custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_apigatewayv2_domain_name" "api" {
  count       = local.has_custom_domain ? 1 : 0
  domain_name = var.api_custom_domain

  domain_name_configuration {
    certificate_arn = aws_acm_certificate.api[0].arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  count       = local.has_custom_domain ? 1 : 0
  api_id      = aws_apigatewayv2_api.petroglyph_api.id
  domain_name = aws_apigatewayv2_domain_name.api[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

output "acm_validation_record" {
  description = "Add this CNAME to Cloudflare to validate the ACM certificate"
  value = local.has_custom_domain ? {
    for dvo in aws_acm_certificate.api[0].domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  } : {}
}

output "api_custom_domain_target" {
  description = "Point this CNAME at your custom domain in Cloudflare once the cert is issued"
  value       = local.has_custom_domain ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name : ""
}
