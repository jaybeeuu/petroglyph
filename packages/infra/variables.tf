# Number of days before staged PDF objects are expired by the S3 lifecycle rule.
# The canonical source of truth at runtime is the SSM parameter
# /petroglyph/config/retention-days; this variable provides the default so that
# `terraform plan` works without an AWS connection during CI validation.
variable "retention_days" {
  description = "Number of days after which staged PDF objects are expired"
  type        = number
  default     = 90
}
