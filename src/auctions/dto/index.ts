// Export all auction DTOs for easy imports
export * from './create-auction.dto';
export * from './place-bid.dto';
export * from './auction-filter.dto';
export * from './watchlist.dto';
export * from './create-auction-item.dto';

// Re-export specific DTOs that are used in controller
export { UpdateProxyBidDto } from './place-bid.dto';