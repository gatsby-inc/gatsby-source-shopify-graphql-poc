import fetch from "node-fetch";
import { createNodeHelpers } from "gatsby-node-helpers";
import { createInterface } from "readline";
import { createOperations } from "./operations";
import { nodeBuilder } from "./node-builder";
import { eventsApi } from "./events";
import { CreateResolversArgs, SourceNodesArgs } from "gatsby";

module.exports.pluginOptionsSchema = ({ Joi }) => {
  return Joi.object({
    apiKey: Joi.string().required(),
    password: Joi.string().required(),
    storeUrl: Joi.string().required(),
    shopifyConnections: Joi.array()
      .default([])
      .items(Joi.string().valid("orders")),
  });
};

function makeSourceFromOperation(
  finishLastOperation: () => Promise<void>,
  completedOperation: (
    id: string
  ) => Promise<{ node: { objectCount: string; url: string } }>,
  gatsbyApi: SourceNodesArgs
) {
  return async function sourceFromOperation(op) {
    const { reporter, actions, createNodeId, createContentDigest } = gatsbyApi;

    const operationComplete = `Sourced from bulk operation`;
    console.time(operationComplete);
    const nodeHelpers = createNodeHelpers({
      typePrefix: `Shopify`,
      createNodeId,
      createContentDigest,
    });

    const finishLastOp = `Checked for operations in progress`;
    console.time(finishLastOp);
    await finishLastOperation();
    console.timeEnd(finishLastOp);

    const initiating = `Initiated bulk operation query`;
    console.time(initiating);
    const {
      bulkOperationRunQuery: { userErrors, bulkOperation },
    } = await op();
    console.timeEnd(initiating);

    if (userErrors.length) {
      reporter.panic(
        {
          id: ``, // TODO: decide on some error IDs
          context: {
            sourceMessage: `Couldn't perform bulk operation`,
          },
        },
        userErrors
      );
    }

    const waitForCurrentOp = `Completed bulk operation`;
    console.time(waitForCurrentOp);
    let resp = await completedOperation(bulkOperation.id);
    console.timeEnd(waitForCurrentOp);

    if (parseInt(resp.node.objectCount, 10) === 0) {
      reporter.info(`No data was returned for this operation`);
      console.timeEnd(operationComplete);
      return;
    }

    const results = await fetch(resp.node.url);

    const rl = createInterface({
      input: results.body,
      crlfDelay: Infinity,
    });

    const builder = nodeBuilder(nodeHelpers, gatsbyApi);

    const creatingNodes = `Created nodes from bulk operation`;
    console.time(creatingNodes);

    const promises = [];
    for await (const line of rl) {
      const obj = JSON.parse(line);
      promises.push(builder.buildNode(obj));
    }

    await Promise.all(
      promises.map(async (promise) => {
        const node = await promise;
        actions.createNode(node);
      })
    );

    console.timeEnd(creatingNodes);

    console.timeEnd(operationComplete);
  };
}

async function sourceAllNodes(
  gatsbyApi: SourceNodesArgs,
  pluginOptions: ShopifyPluginOptions
) {
  const {
    createProductsOperation,
    createOrdersOperation,
    finishLastOperation,
    completedOperation,
  } = createOperations(pluginOptions);

  const operations = [createProductsOperation];
  if (pluginOptions.shopifyConnections.includes("orders")) {
    operations.push(createOrdersOperation);
  }

  const sourceFromOperation = makeSourceFromOperation(
    finishLastOperation,
    completedOperation,
    gatsbyApi
  );
  await Promise.all(operations.map(sourceFromOperation));
}

const shopifyNodeTypes = [
  `ShopifyLineItem`,
  `ShopifyMetafield`,
  `ShopifyOrder`,
  `ShopifyProduct`,
  `ShopifyProductImage`,
  `ShopifyProductVariant`,
  `ShopifyProductVariantPricePair`,
];

async function sourceChangedNodes(
  gatsbyApi: SourceNodesArgs,
  pluginOptions: ShopifyPluginOptions
) {
  const {
    incrementalProducts,
    incrementalOrders,
    finishLastOperation,
    completedOperation,
  } = createOperations(pluginOptions);
  const lastBuildTime = await gatsbyApi.cache.get(`LAST_BUILD_TIME`);
  const touchNode = (node) => gatsbyApi.actions.touchNode({ nodeId: node.id });
  for (const nodeType of shopifyNodeTypes) {
    gatsbyApi.getNodesByType(nodeType).forEach(touchNode);
  }

  const operations = [incrementalProducts];
  if (pluginOptions.shopifyConnections.includes("orders")) {
    operations.push(incrementalOrders);
  }

  const sourceFromOperation = makeSourceFromOperation(
    finishLastOperation,
    completedOperation,
    gatsbyApi
  );

  const deltaSource = (op) => {
    const deltaOp = () => op(new Date(lastBuildTime).toISOString());
    return sourceFromOperation(deltaOp);
  };

  await Promise.all(operations.map(deltaSource));

  const { fetchDestroyEventsSince } = eventsApi(pluginOptions);
  const destroyEvents = await fetchDestroyEventsSince(new Date(lastBuildTime));
  if (destroyEvents.length) {
    for (const nodeType of shopifyNodeTypes) {
      gatsbyApi.getNodesByType(nodeType).forEach((node) => {
        /* This is currently untested because all the destroy events for the
         * swag store are for products that this POC has never sourced!
         *
         * Also to consider: what about cascade delete? If a product is removed
         * here, do we clean up variants, metafields, images, etc?
         */
        const event = destroyEvents.find(
          (e: { subject_id: number; subject_type: string }) =>
            e.subject_id === parseInt(node.shopifyId as string, 10) &&
            node.internal.type === `Shopify${e.subject_type}`
        );
        if (event) {
          gatsbyApi.actions.deleteNode({ node });
        }
      });
    }
  }
}

export async function sourceNodes(
  gatsbyApi: SourceNodesArgs,
  pluginOptions: ShopifyPluginOptions
) {
  const lastBuildTime = await gatsbyApi.cache.get(`LAST_BUILD_TIME`);
  if (lastBuildTime) {
    await sourceChangedNodes(gatsbyApi, pluginOptions);
  } else {
    await sourceAllNodes(gatsbyApi, pluginOptions);
  }

  await gatsbyApi.cache.set(`LAST_BUILD_TIME`, Date.now());
}

exports.createSchemaCustomization = ({ actions }) => {
  actions.createTypes(`
    type ShopifyProductVariant implements Node {
      product: ShopifyProduct @link(from: "productId", by: "shopifyId")
      metafields: [ShopifyMetafield]
      presentmentPrices: [ShopifyProductVariantPricePair]
    }

    type ShopifyProduct implements Node {
      variants: [ShopifyProductVariant]
    }

    type ShopifyMetafield implements Node {
      productVariant: ShopifyProductVariant @link(from: "productVariantId", by: "shopifyId")
    }

    type ShopifyProductVariantPricePair implements Node {
      productVariant: ShopifyProductVariant @link(from: "productVariantId", by: "shopifyId")
    }

    type ShopifyOrder implements Node {
      lineItems: [ShopifyLineItem]
    }

    type ShopifyLineItem implements Node {
      product: ShopifyProduct @link(from: "productId", by: "shopifyId")
    }

    type ShopifyProductImage implements Node {
      altText: String
      originalSrc: String!
      product: ShopifyProduct @link(from: "productId", by: "shopifyId")
      localFile: File @link
    }
  `);
};

/**
 * FIXME
 *
 * What are the types for the resolve functions?
 */
exports.createResolvers = ({ createResolvers }: CreateResolversArgs) => {
  createResolvers({
    ShopifyOrder: {
      lineItems: {
        type: ["ShopifyLineItem"],
        resolve(source, _args, context, _info) {
          return context.nodeModel.runQuery({
            query: {
              filter: {
                orderId: { eq: source.shopifyId },
              },
            },
            type: "ShopifyLineItem",
            firstOnly: false,
          });
        },
      },
    },
    ShopifyProductVariant: {
      presentmentPrices: {
        type: ["ShopifyProductVariantPricePair"],
        resolve(source, _args, context, _info) {
          return context.nodeModel.runQuery({
            query: {
              filter: {
                productVariantId: { eq: source.shopifyId },
              },
            },
            type: "ShopifyProductVariantPricePair",
            firstOnly: false,
          });
        },
      },
      metafields: {
        type: ["ShopifyMetafield"],
        resolve(source, _args, context, _info) {
          return context.nodeModel.runQuery({
            query: {
              filter: {
                productVariantId: { eq: source.shopifyId },
              },
            },
            type: "ShopifyMetafield",
            firstOnly: false,
          });
        },
      },
    },
    ShopifyProduct: {
      images: {
        type: ["ShopifyProductImage"],
        resolve(source, _args, context, _info) {
          return context.nodeModel.runQuery({
            query: {
              filter: {
                productId: { eq: source.shopifyId },
              },
            },
            type: "ShopifyProductImage",
            firstOnly: false,
          });
        },
      },
      variants: {
        type: ["ShopifyProductVariant"],
        resolve(source, _args, context, _info) {
          return context.nodeModel.runQuery({
            query: {
              filter: {
                productId: { eq: source.shopifyId },
              },
            },
            type: "ShopifyProductVariant",
            firstOnly: false,
          });
        },
      },
    },
  });
};