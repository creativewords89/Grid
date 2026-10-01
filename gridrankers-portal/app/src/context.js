import { createContext, useContext } from 'react';

// api, data, dispatch, me, toast, confirm, view state.
export const PortalContext = createContext(null);

export const usePortal = () => useContext(PortalContext);
