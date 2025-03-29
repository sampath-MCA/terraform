terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.16"
    }
  }

  required_version = ">= 1.2.0"
}

provider "aws" {
  region = "us-east-1"
}

# resource "aws_ecr_repository" "demo" {
#   name = "demo"
# }


resource "aws_ecs_cluster" "node-cluster" {
  name = "node-cluster"
}


# Simply specify the family to find the latest ACTIVE revision in that family.

data "aws_iam_role" "ecs_task_execution_role" {
  name = "ecsTaskExecutionRole"
}

data "aws_ecs_task_definition" "demoEcsTaskDef" {
  task_definition = aws_ecs_task_definition.demoEcsTaskDef.family
}

resource "aws_ecs_task_definition" "demoEcsTaskDef" {
  family                   = "demoEcsTaskDef"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = "${data.aws_iam_role.ecs_task_execution_role.arn}"
  container_definitions    = <<TASK_DEFINITION
[
  {
    "name": "iis",
    "image": "524053599265.dkr.ecr.us-east-1.amazonaws.com/demo",
    "cpu": 1024,
    "memory": 2048,
    "essential": true
  }
]
TASK_DEFINITION

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

   // depends_on = [aws_alb_listener.testapp, aws_iam_role_policy_attachment.ecs_task_execution_role]
}

resource "aws_ecs_service" "demoService" {
  name          = "demoService"
  cluster       = aws_ecs_cluster.node-cluster.id
  desired_count = 1
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.alb-sg.id]
    //assign_public_ip = true
  }
  # Track the latest ACTIVE revision
  task_definition = data.aws_ecs_task_definition.demoEcsTaskDef.arn
}

data "aws_ecs_task_execution" "example" {
  cluster         = aws_ecs_cluster.node-cluster.id
  task_definition = aws_ecs_task_definition.demoEcsTaskDef.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.alb-sg.id]
    assign_public_ip = true
  }
}


resource "aws_security_group" "alb-sg" {
  name        = "testapp-load-balancer-security-group"
  description = "controls access to the ALB"
  vpc_id      = aws_vpc.test-vpc.id

  ingress {
    protocol    = "tcp"
    from_port   = var.app_port
    to_port     = var.app_port
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# network.tf



# Fetch AZs in the current region
data "aws_availability_zones" "available" {
}

resource "aws_vpc" "test-vpc" {
  cidr_block = "172.17.0.0/16"
  
}

# Create var.az_count private subnets, each in a different AZ
resource "aws_subnet" "private" {
  count             = var.az_count
  cidr_block        = cidrsubnet(aws_vpc.test-vpc.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  vpc_id            = aws_vpc.test-vpc.id
}

# Create var.az_count public subnets, each in a different AZ
resource "aws_subnet" "public" {
  count                   = var.az_count
  cidr_block              = cidrsubnet(aws_vpc.test-vpc.cidr_block, 8, var.az_count + count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  vpc_id                  = aws_vpc.test-vpc.id
  map_public_ip_on_launch = true
}

# Internet Gateway for the public subnet
resource "aws_internet_gateway" "test-igw" {
  vpc_id = aws_vpc.test-vpc.id
}

# Route the public subnet traffic through the IGW
resource "aws_route" "internet_access" {
  route_table_id         = aws_vpc.test-vpc.main_route_table_id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.test-igw.id
}

# Create a NAT gateway with an Elastic IP for each private subnet to get internet connectivity
resource "aws_eip" "test-eip" {
  count      = var.az_count
  vpc        = true
  depends_on = [aws_internet_gateway.test-igw]
}

resource "aws_nat_gateway" "test-natgw" {
  count         = var.az_count
  subnet_id     = element(aws_subnet.public.*.id, count.index)
  allocation_id = element(aws_eip.test-eip.*.id, count.index)
}

# Create a new route table for the private subnets, make it route non-local traffic through the NAT gateway to the internet
resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.test-vpc.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = element(aws_nat_gateway.test-natgw.*.id, count.index)
  }
}

# Explicitly associate the newly created route tables to the private subnets (so they don't default to the main route table)
resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = element(aws_subnet.private.*.id, count.index)
  route_table_id = element(aws_route_table.private.*.id, count.index)
}
  //depends_on = [aws_alb_listener.testapp, aws_iam_role_policy_attachment.ecs_task_execution_role]
