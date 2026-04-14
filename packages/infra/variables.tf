# Number of days before staged PDF objects are expired by the S3 lifecycle rule.
# The canonical source of truth at runtime is the SSM parameter
# /petroglyph/config/retention-days; this variable provides the default so that
# `terraform plan` works without an AWS connection during CI validation.
variable "api_zip_s3_bucket" {
  description = "S3 bucket containing the API Lambda deployment zip"
  type        = string
}

variable "api_zip_s3_key" {
  description = "S3 key of the API Lambda deployment zip"
  type        = string
}

variable "ingest_onedrive_zip_s3_bucket" {
  description = "S3 bucket containing the ingest-onedrive Lambda deployment zip"
  type        = string
}

variable "ingest_onedrive_zip_s3_key" {
  description = "S3 key of the ingest-onedrive Lambda deployment zip"
  type        = string
}

variable "processor_zip_s3_bucket" {
  description = "S3 bucket containing the processor Lambda deployment zip"
  type        = string
}

variable "processor_zip_s3_key" {
  description = "S3 key of the processor Lambda deployment zip"
  type        = string
}

variable "retention_days" {
  description = "Number of days after which staged PDF objects are expired"
  type        = number
  default     = 90
}
