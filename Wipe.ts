import { config } from "dotenv";
config();

interface ServiceDeployment {
  id: string;
  name: string;
}

const RAILWAY_API_URL = "https://api.railway.app/graphql";
const TOKEN = process.env.RAILWAY_TOKEN;
const PROJECT_ID = process.env.PROJECT_ID || "4573421d-34b8-42a7-bb84-b7472371bd34";
const ENV_ID = process.env.ENVIRONMENT_ID || "b2771178-98d1-4056-9f08-c0bc7c1bd98c";
const VOLUME_ID = process.env.VOLUME_ID || "5134632e-7450-4f18-8347-79e0edd53e60";

const SERVICES: ServiceDeployment[] = [
  { id: "d0ec267b-f343-4e09-8683-42c773c6d676", name: "SheetSubmit" },
  { id: "1b94d4e0-87d6-4510-bfdd-1f396e17af5b", name: "Worker" },
  { id: "cc34a9ae-d761-4e86-8035-043788b9d574", name: "Postgres" },
  { id: "f636a177-32ea-4cd6-87d9-04f144b239e8", name: "Redis" },
];

async function graphqlRequest(query: string, variables?: Record<string, unknown>) {
  const response = await fetch(RAILWAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
  if (data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

async function removeVolume(volumeId: string) {
  console.log(`[1/2] Removing volume ${volumeId}...`);

  const mutation = `
    mutation DeleteVolume($id: String!) {
      volumeDelete(id: $id)
    }
  `;

  await graphqlRequest(mutation, { id: volumeId });
  console.log("✅ Volume removed");
}

async function deployService(serviceId: string, serviceName: string) {
  console.log(`Deploying ${serviceName}...`);

  const mutation = `
    mutation Deploy($projectId: String!, $environmentId: String!, $serviceId: String!) {
      deploymentCreate(
        input: {
          projectId: $projectId
          environmentId: $environmentId
          serviceId: $serviceId
        }
      ) {
        id
      }
    }
  `;

  const result = (await graphqlRequest(mutation, {
    projectId: PROJECT_ID,
    environmentId: ENV_ID,
    serviceId: serviceId,
  })) as { deploymentCreate?: { id: string } };

  return result.deploymentCreate?.id;
}

async function main() {
  if (!TOKEN) {
    console.error("❌ RAILWAY_TOKEN not found in .env");
    process.exit(1);
  }

  try {
    // Step 1: Remove volume
    await removeVolume(VOLUME_ID);

    // Step 2: Redeploy all services
    console.log(`\n[2/2] Redeploying ${SERVICES.length} services...`);
    const deploymentIds: Record<string, string> = {};

    for (const service of SERVICES) {
      const deploymentId = await deployService(service.id, service.name);
      if (deploymentId) {
        deploymentIds[service.name] = deploymentId;
      }
    }

    console.log("\n✅ All services redeployed:");
    Object.entries(deploymentIds).forEach(([name, id]) => {
      console.log(`   - ${name}: ${id}`);
    });

    console.log("\n✨ Wipe and redeploy complete!");
  } catch (error) {
    console.error(
      "❌ Error:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

main();

